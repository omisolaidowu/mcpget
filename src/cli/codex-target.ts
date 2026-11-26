import { createInterface } from "node:readline/promises";
import { CodexAdapter } from "../installers/codex-adapter.js";
import { getCodexAdaptersForContext } from "../installers/adapters.js";
import {
  codexTargetCandidates,
  type CodexTarget,
} from "../installers/codex-scopes.js";
import type { ConfigurationScope } from "../installers/types.js";
import { CliError } from "./output.js";

export interface CodexTargetOptions {
  scope?: ConfigurationScope;
  config?: string;
  codexProfile?: string;
}

export async function resolveCodexTargets(
  options: CodexTargetOptions,
): Promise<{
  context: Awaited<ReturnType<typeof getCodexAdaptersForContext>>["context"];
  adapters: CodexAdapter[];
  candidates: CodexTarget[];
}> {
  const resolved = await getCodexAdaptersForContext(options.codexProfile);
  const candidates = codexTargetCandidates(resolved.context, {
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.config ? { configPath: options.config } : {}),
  });
  return {
    context: resolved.context,
    adapters: resolved.allAdapters,
    candidates,
  };
}

export function codexAdapterForTarget(
  target: CodexTarget,
  adapters: CodexAdapter[],
): CodexAdapter {
  return (
    adapters.find((adapter) => adapter.configPath() === target.path) ??
    new CodexAdapter(target.path, undefined, undefined, target.scope)
  );
}

export async function chooseCodexTarget(
  candidates: CodexTarget[],
  json = false,
): Promise<CodexTarget> {
  if (candidates.length === 1) return candidates[0]!;
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new CliError(
      "MISSING_REQUIRED_INPUT",
      `Codex configuration target is ambiguous. Use --scope user|project${candidates.some((candidate) => candidate.scope === "project") ? " and --config <path> for project layers" : ""}.`,
    );

  const output = json ? process.stderr : process.stdout;
  const lines = candidates.map(
    (candidate, index) =>
      `${index + 1}. ${candidate.scope} scope — ${candidate.path}`,
  );
  const rl = createInterface({ input: process.stdin, output });
  try {
    const answer = await rl.question(
      `Choose one Codex configuration to target:\n${lines.join("\n")}\nSelection: `,
    );
    const index = Number.parseInt(answer.trim(), 10) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length)
      throw new CliError(
        "INVALID_INPUT",
        "Codex configuration selection is invalid.",
      );
    return candidates[index]!;
  } finally {
    rl.close();
  }
}

export function requireCodexScope(
  value: string | undefined,
): ConfigurationScope | undefined {
  if (value === undefined) return undefined;
  if (value === "user" || value === "project") return value;
  throw new CliError(
    "INVALID_INPUT",
    `Unsupported Codex scope "${value}". Choose user or project.`,
  );
}
