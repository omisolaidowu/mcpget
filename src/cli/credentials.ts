import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { RegistryInputRequirement } from "../models/server-candidate.js";

export class CredentialPromptCancelled extends Error {
  constructor() {
    super("Credential entry cancelled.");
    this.name = "CredentialPromptCancelled";
  }
}

export interface CredentialPrompt {
  keepExisting(name: string): Promise<boolean>;
  readValue(name: string, secret: boolean, description?: string): Promise<string | undefined>;
}

export interface CredentialCollection {
  values: Record<string, string>;
  skipped: string[];
  oauth: string[];
  unsupported: string[];
}

export function formatCredentialPrompt(name: string, description?: string): string {
  const segments = (description ?? "").split("|").map((segment) => segment.trim())
    .filter((segment) => segment && segment.toLowerCase() !== name.toLowerCase() && !/^(?:—|-|required|optional)$/i.test(segment));
  const descriptor = segments.find((segment) => /api[\s_-]*key|token|password|credential|secret/i.test(segment));
  const rawFormatHint = descriptor?.match(/\(([^()]*(?:\.\.\.|…|<[^>]+>)[^()]*)\)/)?.[1] ??
    description?.match(/(?:expected\s+)?format\s*:\s*([^|;]+)/i)?.[1];
  const formatHint = rawFormatHint ? cleanCredentialDescription(rawFormatHint).replace(/^format\s*:?\s*/i, "").slice(0, 120) : undefined;
  const envPrefix = name.replace(/_(?:API_)?(?:KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)$/i, "").replace(/_/g, " ");
  const humanPrefix = titleCaseEnvName(envPrefix);
  const baseLabel = descriptor ? cleanCredentialLabel(descriptor, name) : undefined;
  const label = baseLabel
    ? new RegExp(`\\b${escapeRegex(humanPrefix)}\\b`, "i").test(baseLabel) || !humanPrefix
      ? baseLabel
      : `${humanPrefix} ${baseLabel}`
    : titleCaseEnvName(name);
  const inputLabel = label.match(/\b(?:API\s+key|access token|token|password|credential|secret)\b/i)?.[0] ?? label;
  return [
    "Authentication required",
    "",
    label,
    `Environment variable: ${name}`,
    ...(formatHint ? [`Expected format: ${formatHint}`] : []),
    "",
    `Enter ${inputLabel}: `,
  ].join("\n");
}

export async function collectRequiredCredentials(
  inputs: RegistryInputRequirement[],
  existing: Record<string, string>,
  supportsEnvironment: boolean,
  prompt: CredentialPrompt = terminalCredentialPrompt,
): Promise<CredentialCollection> {
  const result: CredentialCollection = { values: {}, skipped: [], oauth: [], unsupported: [] };
  const seen = new Set<string>();
  for (const input of inputs) {
    if (input.required !== true || seen.has(input.name)) continue;
    seen.add(input.name);
    if (/oauth/i.test(`${input.name} ${input.description ?? ""}`)) {
      result.oauth.push(input.name);
      continue;
    }
    if (input.name.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.name)) {
      throw new Error("A required environment variable name from server metadata is invalid.");
    }
    if (!supportsEnvironment) {
      result.unsupported.push(input.name);
      continue;
    }
    const secret = input.secret === true || /(?:token|secret|password|credential|api[_ -]?key)/i.test(input.name);
    if (Object.prototype.hasOwnProperty.call(existing, input.name) && await prompt.keepExisting(input.name)) {
      result.values[input.name] = existing[input.name]!;
      continue;
    }
    const value = await prompt.readValue(input.name, secret, input.description);
    if (value === undefined || value.length === 0) result.skipped.push(input.name);
    else result.values[input.name] = value;
  }
  return result;
}

const terminalCredentialPrompt: CredentialPrompt = {
  async keepExisting(name) {
    const answer = await terminalQuestion(`A value for ${name} is already configured. Keep it? [Y/n] `);
    return !/^n(o)?$/i.test(answer.trim());
  },
  async readValue(name, secret, description) {
    const prompt = cleanPromptText(formatCredentialPrompt(name, description));
    if (secret) return readHiddenValue(prompt);
    const value = await terminalQuestion(prompt);
    return value.length ? value : undefined;
  },
};

function terminalQuestion(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    const onSigint = (): void => {
      rl.close();
      process.stdin.pause();
      reject(new CredentialPromptCancelled());
    };
    rl.once("SIGINT", onSigint);
    rl.question(prompt).then(resolve, reject).finally(() => {
      rl.removeListener("SIGINT", onSigint);
      rl.close();
      process.stdin.pause();
    });
  });
}

export interface HiddenPromptInput extends Readable {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode(mode: boolean): this;
}

export interface HiddenPromptOutput extends Writable {
  isTTY?: boolean;
}

function readHiddenValue(prompt: string): Promise<string | undefined> {
  return readHiddenInput(process.stdin, process.stdout, prompt);
}

export function readHiddenInput(input: HiddenPromptInput, output: HiddenPromptOutput, prompt: string): Promise<string | undefined> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Hidden credential entry requires an interactive terminal; no credential was read.");
  }
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw ?? false;
    let value = "";
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      input.removeListener("data", onData);
      input.setRawMode(wasRaw);
      output.write("\n");
      input.pause();
    };
    const onData = (chunk: string | Buffer): void => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          reject(new CredentialPromptCancelled());
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value.length ? value : undefined);
          return;
        }
        if (character === "\u0008" || character === "\u007f") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    try {
      output.write(prompt);
      input.setRawMode(true);
      input.setEncoding("utf8");
      input.resume();
      input.on("data", onData);
    } catch (error) {
      cleanup();
      reject(new Error("Could not read credential input from the terminal.", { cause: error }));
    }
  });
}

function cleanPromptText(value: string): string {
  return [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? character === "\n" ? "\n" : " " : character;
  }).join("").slice(0, 500);
}

function cleanCredentialLabel(description: string, name: string): string | undefined {
  const label = cleanCredentialDescription(description.replace(/\([^()]*\)/g, "").replace(new RegExp(escapeRegex(name), "ig"), " "))
    .replace(/\b(?:required|optional|must provide|must set|environment variable|is required|is needed)\b/ig, " ")
    .replace(/^[|:—\-\s]+|[|:—\-\s]+$/g, "")
    .replace(/\s+/g, " ").trim().slice(0, 120);
  return /api\s*key|token|password|credential|secret/i.test(label) ? label : undefined;
}

function cleanCredentialDescription(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/`{1,3}/g, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ").trim();
}

function titleCaseEnvName(value: string): string {
  return value.split(/[\s_]+/).filter(Boolean).map((part) => {
    const upper = part.toUpperCase();
    if (["API", "ID", "URL", "URI", "OAUTH", "HTTP"].includes(upper)) return upper;
    if (["KEY", "TOKEN", "PASSWORD", "SECRET", "CREDENTIAL"].includes(upper)) return part.toLowerCase();
    return `${part[0]!.toUpperCase()}${part.slice(1).toLowerCase()}`;
  }).join(" ");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
