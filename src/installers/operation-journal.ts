import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigurationScope } from "./types.js";
import { renameWithRetry, withFileLock } from "./file-lock.js";

export type OperationKind = "install" | "remove";
export type OperationPhase =
  | "started"
  | "package_installed"
  | "association_reserved"
  | "configuration_written"
  | "metadata_updated"
  | "state_updated";

export interface PendingOperation {
  schemaVersion: 1;
  id: string;
  kind: OperationKind;
  phase: OperationPhase;
  client: string;
  configPath: string;
  configScope?: ConfigurationScope;
  projectRoot?: string;
  configName: string;
  serverIdentifier: string;
  installationPath?: string;
  packageIdentifier?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BackupResolutionRecord {
  schemaVersion: 1;
  id: string;
  kind: "configuration_backup_resolution";
  action: "archive_orphaned_backup";
  status: "started" | "completed" | "failed";
  client: string;
  configPath: string;
  backupPath: string;
  archivePath: string;
  backupSha256: string;
  activeSha256: string;
  createdAt: string;
  updatedAt: string;
}

export class OperationJournal {
  constructor(readonly directory = join(homedir(), ".mcpget", "operations")) {}

  async begin(
    operation: Omit<
      PendingOperation,
      "schemaVersion" | "id" | "phase" | "createdAt" | "updatedAt"
    >,
  ): Promise<PendingOperation> {
    const now = new Date().toISOString();
    const record: PendingOperation = {
      schemaVersion: 1,
      id: randomUUID(),
      ...operation,
      phase: "started",
      createdAt: now,
      updatedAt: now,
    };
    await mkdir(this.directory, { recursive: true });
    await this.write(record);
    return record;
  }

  async advance(id: string, phase: OperationPhase): Promise<void> {
    const path = this.path(id);
    await withFileLock(path, async () => {
      const current = await this.read(path);
      if (!current) throw new Error("Recovery journal entry disappeared.");
      await this.write({
        ...current,
        phase,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async complete(id: string): Promise<void> {
    const path = this.path(id);
    await withFileLock(path, () => rm(path, { force: true }));
  }

  async list(): Promise<PendingOperation[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const result: PendingOperation[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = await this.read(join(this.directory, name));
      if (!record)
        throw new Error("Recovery journal contains an invalid entry.");
      result.push(record);
    }
    return result;
  }

  async beginBackupResolution(
    resolution: Omit<
      BackupResolutionRecord,
      | "schemaVersion"
      | "id"
      | "kind"
      | "action"
      | "status"
      | "createdAt"
      | "updatedAt"
    >,
  ): Promise<BackupResolutionRecord> {
    const now = new Date().toISOString();
    const record: BackupResolutionRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      kind: "configuration_backup_resolution",
      action: "archive_orphaned_backup",
      status: "started",
      ...resolution,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeBackupResolution(record, true);
    return record;
  }

  async finishBackupResolution(
    id: string,
    status: "completed" | "failed",
  ): Promise<void> {
    const path = this.resolutionPath(id);
    await withFileLock(path, async () => {
      const current = await this.readBackupResolution(path);
      if (!current)
        throw new Error("Backup resolution journal entry disappeared.");
      await this.writeBackupResolution(
        { ...current, status, updatedAt: new Date().toISOString() },
        false,
      );
    });
  }

  async listBackupResolutions(): Promise<BackupResolutionRecord[]> {
    const directory = join(this.directory, "resolutions");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: BackupResolutionRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = await this.readBackupResolution(join(directory, name));
      if (!record)
        throw new Error(
          "Recovery journal contains an invalid backup resolution.",
        );
      records.push(record);
    }
    return records;
  }

  private path(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new Error("Recovery journal identifier is invalid.");
    return join(this.directory, `${id}.json`);
  }

  private resolutionPath(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new Error("Backup resolution journal identifier is invalid.");
    return join(this.directory, "resolutions", `${id}.json`);
  }

  private async read(path: string): Promise<PendingOperation | undefined> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(
        "Recovery journal entry is malformed; it was left unchanged.",
      );
    }
    if (!isPendingOperation(value))
      throw new Error(
        "Recovery journal entry has an unsupported format; it was left unchanged.",
      );
    return value;
  }

  private async write(record: PendingOperation): Promise<void> {
    const path = this.path(record.id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await renameWithRetry(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async readBackupResolution(
    path: string,
  ): Promise<BackupResolutionRecord | undefined> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(
        "Backup resolution journal entry is malformed; it was left unchanged.",
      );
    }
    if (!isBackupResolutionRecord(value))
      throw new Error(
        "Backup resolution journal entry has an unsupported format; it was left unchanged.",
      );
    return value;
  }

  private async writeBackupResolution(
    record: BackupResolutionRecord,
    exclusive: boolean,
  ): Promise<void> {
    const path = this.resolutionPath(record.id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(join(this.directory, "resolutions"), { recursive: true });
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      if (exclusive) {
        await link(temporary, path);
        await unlink(temporary);
      } else {
        await renameWithRetry(temporary, path);
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function isPendingOperation(value: unknown): value is PendingOperation {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.id === "string" &&
    /^[0-9a-f-]{36}$/i.test(record.id) &&
    (record.kind === "install" || record.kind === "remove") &&
    [
      "started",
      "package_installed",
      "association_reserved",
      "configuration_written",
      "metadata_updated",
      "state_updated",
    ].includes(String(record.phase)) &&
    typeof record.client === "string" &&
    typeof record.configPath === "string" &&
    (record.configScope === undefined ||
      record.configScope === "user" ||
      record.configScope === "project" ||
      record.configScope === "local") &&
    (record.projectRoot === undefined ||
      typeof record.projectRoot === "string") &&
    typeof record.configName === "string" &&
    typeof record.serverIdentifier === "string" &&
    (record.installationPath === undefined ||
      typeof record.installationPath === "string") &&
    (record.packageIdentifier === undefined ||
      typeof record.packageIdentifier === "string") &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

function isBackupResolutionRecord(
  value: unknown,
): value is BackupResolutionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.id === "string" &&
    /^[0-9a-f-]{36}$/i.test(record.id) &&
    record.kind === "configuration_backup_resolution" &&
    record.action === "archive_orphaned_backup" &&
    ["started", "completed", "failed"].includes(String(record.status)) &&
    typeof record.client === "string" &&
    typeof record.configPath === "string" &&
    typeof record.backupPath === "string" &&
    typeof record.archivePath === "string" &&
    typeof record.backupSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(record.backupSha256) &&
    typeof record.activeSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(record.activeSha256) &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}
