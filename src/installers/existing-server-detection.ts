import { isAbsolute, resolve } from "node:path";
import type { InstallationRecord } from "../models/installation.js";
import {
  normalizeServerRegistration,
  type ExistingServerRegistration,
  type ServerConfiguration,
} from "./types.js";

export type ExistingMatchClassification =
  "confirmed_duplicate" | "possible_duplicate" | "name_conflict";

export interface ExistingServerMatch {
  classification: ExistingMatchClassification;
  name: string;
  configPath: string;
  configScope: string;
  reason: string;
}

export function detectExistingServerMatches(
  candidateId: string,
  proposed: ServerConfiguration,
  proposedPackageIdentifier: string | undefined,
  registrations: ExistingServerRegistration[],
  records: InstallationRecord[],
): ExistingServerMatch[] {
  const matches: ExistingServerMatch[] = [];
  const seenCopilotTargets = new Set<string>();
  const proposedRegistration = normalizeServerRegistration(
    registrations[0]?.client ?? "codex",
    "",
    "user",
    proposed,
  );
  for (const registration of registrations) {
    const sharedCopilot =
      registration.client === "copilot-vscode" ||
      registration.client === "copilot-cli";
    const targetKey = sharedCopilot
      ? `copilot\0${registration.configPath}\0${registration.name}`
      : `${registration.client}\0${registration.configPath}\0${registration.name}`;
    if (seenCopilotTargets.has(targetKey)) continue;
    seenCopilotTargets.add(targetKey);
    const state = records.find(
      (record) =>
        record.configPath === registration.configPath &&
        record.configName === registration.name &&
        (record.client === registration.client ||
          ((record.client === "copilot-vscode" ||
            record.client === "copilot-cli") &&
            (registration.client === "copilot-vscode" ||
              registration.client === "copilot-cli"))),
    );
    const sameRegistryIdentity =
      (state?.serverIdentifier === candidateId &&
        stateMatchesConfiguration(state, registration, proposed)) ||
      registration.registryIdentity === candidateId;
    const conflictingRegistryIdentity =
      (state !== undefined && state.serverIdentifier !== candidateId) ||
      (registration.registryIdentity !== undefined &&
        registration.registryIdentity !== candidateId);
    const existing: ExistingServerRegistration = {
      ...registration,
      ...(state?.serverIdentifier
        ? { registryIdentity: state.serverIdentifier }
        : {}),
      ...(state?.packageIdentifier
        ? { packageIdentifier: state.packageIdentifier }
        : {}),
      ...(state?.installedVersion
        ? { packageVersion: state.installedVersion }
        : {}),
      ...(state?.installationPath
        ? { managedInstallationPath: state.installationPath }
        : {}),
    };
    const exactConfig = registrationsEquivalent(existing, proposedRegistration);
    const existingPackage =
      existing.packageIdentifier ??
      extractNpmPackage(existing.command, existing.arguments);
    const samePackage =
      proposedPackageIdentifier !== undefined &&
      existingPackage !== undefined &&
      normalizePackageIdentifier(existingPackage) ===
        normalizePackageIdentifier(proposedPackageIdentifier);
    const sameEndpoint =
      existing.remoteEndpoint !== undefined &&
      proposedRegistration.remoteEndpoint !== undefined &&
      normalizeEndpoint(existing.remoteEndpoint) ===
        normalizeEndpoint(proposedRegistration.remoteEndpoint) &&
      compatibleTransport(existing.transport, proposedRegistration.transport);
    const sameLaunch =
      existing.command !== undefined &&
      proposedRegistration.command !== undefined &&
      normalizeCommand(existing.command) ===
        normalizeCommand(proposedRegistration.command) &&
      arraysEqual(existing.arguments, proposedRegistration.arguments);
    const { name, configPath, configScope } = registration;

    if (sameRegistryIdentity) {
      matches.push({
        classification: "confirmed_duplicate",
        name,
        configPath,
        configScope,
        reason: "The same Official MCP Registry identity is already recorded.",
      });
    } else if (name === proposed.name) {
      if (conflictingRegistryIdentity) {
        matches.push({
          classification: "name_conflict",
          name,
          configPath,
          configScope,
          reason:
            "The registration name belongs to a different recorded Registry identity.",
        });
      } else if (exactConfig) {
        matches.push({
          classification: "confirmed_duplicate",
          name,
          configPath,
          configScope,
          reason: "The exact registration is already configured.",
        });
      } else {
        matches.push({
          classification: "name_conflict",
          name,
          configPath,
          configScope,
          reason:
            "The registration name is already used by a different or incomplete configuration.",
        });
      }
    } else if (sameEndpoint || sameLaunch || samePackage) {
      matches.push({
        classification: "possible_duplicate",
        name,
        configPath,
        configScope,
        reason: sameEndpoint
          ? "A different-name registration uses the same remote endpoint."
          : sameLaunch
            ? "A different-name registration has the same normalized command and arguments."
            : "A different-name registration references the same npm package.",
      });
    }
  }
  return matches;
}

export function registrationsEquivalent(
  left: ExistingServerRegistration,
  right: ExistingServerRegistration,
): boolean {
  if (left.remoteEndpoint || right.remoteEndpoint)
    return Boolean(
      left.remoteEndpoint &&
      right.remoteEndpoint &&
      normalizeEndpoint(left.remoteEndpoint) ===
        normalizeEndpoint(right.remoteEndpoint) &&
      compatibleTransport(left.transport, right.transport),
    );
  return Boolean(
    left.command &&
    right.command &&
    compatibleTransport(left.transport, right.transport) &&
    normalizeCommand(left.command) === normalizeCommand(right.command) &&
    arraysEqual(left.arguments, right.arguments),
  );
}

function compatibleTransport(left: string, right: string): boolean {
  const normalize = (transport: string): string =>
    ["http", "streamable-http", "streamable_http"].includes(
      transport.toLowerCase(),
    )
      ? "streamable_http"
      : transport.toLowerCase();
  return normalize(left) === normalize(right);
}

function normalizeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return endpoint;
  }
}

function stateMatchesConfiguration(
  state: InstallationRecord,
  registration: ExistingServerRegistration,
  proposed: ServerConfiguration,
): boolean {
  if (state.remoteEndpoint)
    return (
      registration.remoteEndpoint !== undefined &&
      normalizeEndpoint(state.remoteEndpoint) ===
        normalizeEndpoint(registration.remoteEndpoint)
    );
  if (state.installationPath) {
    const root = state.installationPath.replace(/[\\/]+$/, "");
    const values = [registration.command, ...registration.arguments].filter(
      (value): value is string => typeof value === "string",
    );
    return values.some(
      (value) =>
        value === root ||
        value.startsWith(`${root}/`) ||
        value.startsWith(`${root}\\`),
    );
  }
  if (state.packageIdentifier) {
    const packageReference = extractNpmPackage(
      registration.command,
      registration.arguments,
    );
    return (
      packageReference !== undefined &&
      normalizePackageIdentifier(packageReference) ===
        normalizePackageIdentifier(state.packageIdentifier)
    );
  }
  return registrationsEquivalent(
    registration,
    normalizeServerRegistration(
      registration.client,
      registration.configPath,
      registration.configScope,
      proposed,
    ),
  );
}

function normalizeCommand(command: string): string {
  const normalized = isAbsolute(command) ? resolve(command) : command;
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function extractNpmPackage(
  command: string | undefined,
  args: string[],
): string | undefined {
  if (!command) return undefined;
  const commandName = command.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (!["npx", "npx.cmd", "npm", "npm.cmd"].includes(commandName))
    return undefined;
  const start = args.indexOf("--");
  const values = start >= 0 ? args.slice(start + 1) : args;
  return values.find((value) =>
    /^(?:@[a-z0-9._~-]+\/)?[a-z0-9][a-z0-9._~-]*(?:@[a-z0-9.+_-]+)?$/i.test(
      value,
    ),
  );
}

function normalizePackageIdentifier(identifier: string): string {
  const versionAt = identifier.lastIndexOf("@");
  const scopedStart = identifier.startsWith("@") ? identifier.indexOf("/") : -1;
  const packageName =
    versionAt > scopedStart ? identifier.slice(0, versionAt) : identifier;
  return packageName.toLowerCase();
}

function arraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((value, i) => value === right[i])
  );
}
