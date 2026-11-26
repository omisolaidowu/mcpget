import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { InstallationRecord } from "../models/installation.js";
import { renameWithRetry, withFileLock } from "./file-lock.js";

interface StateFile {
  schemaVersion: 1;
  installations: InstallationRecord[];
  [key: string]: unknown;
}
const EMPTY: StateFile = { schemaVersion: 1, installations: [] };

export class InstallationStateStore {
  constructor(
    readonly path = join(homedir(), ".mcpget", "installations.json"),
  ) {}
  async all(): Promise<InstallationRecord[]> {
    return (await this.read()).installations;
  }
  async get(
    id: string,
    client?: string,
    configPath?: string,
  ): Promise<InstallationRecord | undefined> {
    return (await this.all()).find(
      (record) =>
        record.id === id &&
        (!client || record.client === client) &&
        (!configPath || record.configPath === configPath),
    );
  }
  async put(record: InstallationRecord): Promise<void> {
    await withFileLock(this.path, async () => {
      const file = await this.read();
      const index = file.installations.findIndex(
        (item) =>
          item.id === record.id &&
          item.client === record.client &&
          item.configPath === record.configPath,
      );
      if (index < 0) file.installations.push(record);
      else file.installations[index] = record;
      await this.write(file);
    });
  }
  async delete(id: string, client: string, configPath?: string): Promise<void> {
    await withFileLock(this.path, async () => {
      const file = await this.read();
      file.installations = file.installations.filter(
        (item) =>
          item.id !== id ||
          item.client !== client ||
          (configPath !== undefined && item.configPath !== configPath),
      );
      await this.write(file);
    });
  }
  private async read(): Promise<StateFile> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return structuredClone(EMPTY);
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(
        "MCPGet installation state is invalid JSON; it was left unchanged.",
      );
    }
    if (!isStateFile(value))
      throw new Error(
        "MCPGet installation state has an unsupported format; it was left unchanged.",
      );
    return value;
  }
  private async write(value: StateFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await renameWithRetry(temp, this.path);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
function isStateFile(value: unknown): value is StateFile {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as StateFile).schemaVersion === 1 &&
    Array.isArray((value as StateFile).installations)
  )
    return (value as StateFile).installations.every(isInstallationRecord);
  return false;
}

function isInstallationRecord(value: unknown): value is InstallationRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  const states = record.states;
  return (
    typeof record.id === "string" &&
    typeof record.serverIdentifier === "string" &&
    typeof record.displayName === "string" &&
    (record.client === "claude" ||
      record.client === "claude-code" ||
      record.client === "copilot-vscode" ||
      record.client === "copilot-cli" ||
      record.client === "codex" ||
      record.client === "cursor") &&
    typeof record.source === "string" &&
    (record.strategy === "managed" ||
      record.strategy === "ephemeral" ||
      record.strategy === "remote") &&
    typeof record.configName === "string" &&
    typeof record.configPath === "string" &&
    (record.configScope === undefined ||
      record.configScope === "user" ||
      record.configScope === "project" ||
      record.configScope === "local") &&
    (record.projectRoot === undefined ||
      typeof record.projectRoot === "string") &&
    typeof record.createdAt === "string" &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    (record.installationPath === undefined ||
      typeof record.installationPath === "string") &&
    (record.packageIdentifier === undefined ||
      typeof record.packageIdentifier === "string") &&
    (record.installedVersion === undefined ||
      typeof record.installedVersion === "string") &&
    (record.lifecycleScriptsEnabled === undefined ||
      typeof record.lifecycleScriptsEnabled === "boolean") &&
    (record.remoteEndpoint === undefined ||
      typeof record.remoteEndpoint === "string") &&
    (record.remoteEndpointTrust === undefined ||
      record.remoteEndpointTrust === "pending" ||
      record.remoteEndpointTrust === "public_https" ||
      record.remoteEndpointTrust === "rejected") &&
    (record.lastError === undefined || typeof record.lastError === "string") &&
    typeof states === "object" &&
    states !== null &&
    !Array.isArray(states) &&
    [
      "resolved",
      "install_confirmed",
      "installed",
      "execution_registered",
      "configured",
      "setup_required",
      "authenticated",
      "startup_verified",
      "connection_verified",
      "client_connection_verified",
    ].every((key) =>
      isInstallationStep((states as Record<string, unknown>)[key]),
    )
  );
}

function isInstallationStep(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const step = value as Record<string, unknown>;
  return (
    [
      "completed",
      "not_applicable",
      "not_verified",
      "authentication_required",
      "setup_required",
      "failed",
    ].includes(String(step.status)) &&
    typeof step.detail === "string" &&
    (step.at === undefined || typeof step.at === "string")
  );
}
