import type { ServerCandidate } from "../models/server-candidate.js";

export type ClientId =
  | "claude"
  | "claude-code"
  | "copilot-vscode"
  | "copilot-cli"
  | "codex"
  | "cursor";
export type ConfigurationScope = "user" | "project" | "local";
export interface ServerConfiguration {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  transport?: string;
  type?: "stdio" | "http";
}
export interface ExistingServerRegistration {
  client: ClientId;
  name: string;
  configPath: string;
  configScope: ConfigurationScope;
  transport: string;
  remoteEndpoint?: string;
  command?: string;
  arguments: string[];
  environmentVariableNames: string[];
  registryIdentity?: string;
  packageIdentifier?: string;
  packageVersion?: string;
  managedInstallationPath?: string;
}
export interface ClientAdapter {
  readonly id: ClientId;
  readonly displayName: string;
  configPath(): string;
  configScope(): ConfigurationScope;
  detect(): Promise<boolean>;
  read(): Promise<Record<string, ServerConfiguration>>;
  readRegistrations?(): Promise<ExistingServerRegistration[]>;
  add(entry: ServerConfiguration, operationId?: string): Promise<void>;
  verify(
    entry: ServerConfiguration,
  ): Promise<{ verified: boolean; detail: string }>;
  remove(name: string, operationId?: string): Promise<boolean>;
  verifyRemoved(name: string): Promise<boolean>;
  authenticate?(name: string): Promise<void>;
  projectApprovalStatus?(
    name: string,
  ): Promise<"approved" | "disabled" | "pending">;
}
export function normalizeServerRegistration(
  client: ClientId,
  configPath: string,
  configScope: ConfigurationScope,
  entry: ServerConfiguration,
): ExistingServerRegistration {
  return {
    client,
    name: entry.name,
    configPath,
    configScope,
    transport:
      entry.transport ??
      entry.type ??
      (entry.url ? "streamable_http" : "stdio"),
    ...(entry.url ? { remoteEndpoint: entry.url } : {}),
    ...(entry.command ? { command: entry.command } : {}),
    arguments: [...(entry.args ?? [])],
    environmentVariableNames: Object.keys(entry.env ?? {}).sort(),
  };
}
export interface InstallPlan {
  candidate: ServerCandidate;
  entry: ServerConfiguration;
  requiresExecutionConsent: boolean;
  method: string;
  packageIdentifier?: string;
  packageVersion?: string;
  packageType?: string;
  strategy: "managed" | "ephemeral" | "remote";
}
