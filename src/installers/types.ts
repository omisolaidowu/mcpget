import type { ServerCandidate } from "../models/server-candidate.js";

export type ClientId = "claude" | "codex" | "cursor";
export interface ServerConfiguration {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  transport?: string;
  type?: "stdio" | "http";
}
export interface ClientAdapter {
  readonly id: ClientId;
  readonly displayName: string;
  configPath(): string;
  configScope(): "user";
  detect(): Promise<boolean>;
  read(): Promise<Record<string, ServerConfiguration>>;
  add(entry: ServerConfiguration): Promise<void>;
  verify(entry: ServerConfiguration): Promise<{ verified: boolean; detail: string }>;
  remove(name: string): Promise<boolean>;
  verifyRemoved(name: string): Promise<boolean>;
  authenticate?(name: string): Promise<void>;
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
