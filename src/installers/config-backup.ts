import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { renameWithRetry } from "./file-lock.js";
import type { PendingOperation } from "./operation-journal.js";

export type ConfigBackupOutcome =
  "in_progress" | "commit_confirmed" | "rollback_confirmed" | "rollback_failed";

export type ConfigBackupClassification =
  "confirmed_incomplete" | "failed_rollback" | "orphaned" | "ambiguous";

export interface ConfigBackupMetadata {
  schemaVersion: 1;
  transactionId: string;
  operationId?: string;
  operationKind: "install" | "remove" | "direct";
  configPath: string;
  backupSha256: string;
  activeSha256?: string;
  outcome: ConfigBackupOutcome;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigBackupAssessment {
  path: string;
  classification: ConfigBackupClassification;
  detail: string;
  canReconcile?: boolean;
}

export interface ConfigBackupContext {
  operationId?: string;
  operationKind?: "install" | "remove";
}

export function configBackupPath(path: string): string {
  return `${path}.mcpget.bak`;
}

export function configBackupMetadataPath(path: string): string {
  return `${configBackupPath(path)}.meta.json`;
}

export function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function listConfigBackupArtifacts(
  path: string,
): Promise<string[]> {
  const directory = dirname(path);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const backupName = basename(configBackupPath(path));
  const metadataName = basename(configBackupMetadataPath(path));
  const configName = basename(path);
  const backupExists = entries.includes(backupName);
  return entries
    .filter(
      (entry) =>
        entry === backupName ||
        (entry === metadataName && !backupExists) ||
        (entry.startsWith(`${backupName}.`) && entry.endsWith(".tmp")) ||
        (entry.startsWith(`${metadataName}.`) && entry.endsWith(".tmp")) ||
        (entry.startsWith(`${configName}.mcpget-`) &&
          (entry.endsWith(".tmp") || entry.endsWith(".rollback.tmp"))),
    )
    .map((entry) => join(directory, entry));
}

export async function assertNoConfigBackupArtifacts(
  path: string,
): Promise<void> {
  if ((await listConfigBackupArtifacts(path)).length)
    throw new Error(
      "Unresolved configuration backup artifacts exist; refusing to modify this configuration.",
    );
}

export async function createConfigBackup(
  path: string,
  contents: Buffer,
  context: ConfigBackupContext = {},
): Promise<string> {
  const backupPath = configBackupPath(path);
  const temporary = `${backupPath}.${process.pid}.${randomUUID()}.tmp`;
  await assertNoConfigBackupArtifacts(path);
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await link(temporary, backupPath);
    await chmod(backupPath, 0o600);
    await unlink(temporary);
    const now = new Date().toISOString();
    const metadata: ConfigBackupMetadata = {
      schemaVersion: 1,
      transactionId: randomUUID(),
      ...(context.operationId ? { operationId: context.operationId } : {}),
      operationKind: context.operationKind ?? "direct",
      configPath: path,
      backupSha256: sha256(contents),
      outcome: "in_progress",
      createdAt: now,
      updatedAt: now,
    };
    await writeMetadata(configBackupMetadataPath(path), metadata, true);
    return backupPath;
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readConfigBackupMetadata(
  path: string,
): Promise<ConfigBackupMetadata | undefined> {
  let contents: string;
  try {
    contents = await readFile(configBackupMetadataPath(path), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("Configuration backup metadata is malformed.");
  }
  if (!isConfigBackupMetadata(value) || value.configPath !== path)
    throw new Error("Configuration backup metadata is invalid.");
  return value;
}

export async function recordConfigBackupOutcome(
  path: string,
  expectedContents: Buffer,
  outcome: Exclude<ConfigBackupOutcome, "in_progress">,
): Promise<void> {
  const metadata = await readConfigBackupMetadata(path);
  if (!metadata) throw new Error("Configuration backup metadata is missing.");
  const backupContents = await readFile(configBackupPath(path));
  if (
    !backupContents.equals(expectedContents) ||
    metadata.backupSha256 !== sha256(backupContents)
  )
    throw new Error("Configuration backup changed; it was retained.");

  let activeSha256: string | undefined;
  if (outcome !== "rollback_failed") {
    const activeContents = await readFile(path);
    if (
      outcome === "rollback_confirmed" &&
      !activeContents.equals(expectedContents)
    )
      throw new Error("Restored configuration does not match its backup.");
    activeSha256 = sha256(activeContents);
  }

  await writeMetadata(configBackupMetadataPath(path), {
    ...metadata,
    ...(activeSha256 ? { activeSha256 } : {}),
    outcome,
    updatedAt: new Date().toISOString(),
  });
}

export async function classifyConfigBackupArtifacts(
  path: string,
  operations: PendingOperation[] | undefined,
): Promise<ConfigBackupAssessment[]> {
  const artifacts = await listConfigBackupArtifacts(path);
  const backupPath = configBackupPath(path);
  const results: ConfigBackupAssessment[] = [];

  for (const artifact of artifacts) {
    if (artifact !== backupPath) {
      results.push({
        path: artifact,
        classification: "ambiguous",
        detail:
          "A staging or metadata-only artifact has insufficient transaction evidence and was left unchanged.",
      });
      continue;
    }

    let backupContents: Buffer;
    try {
      backupContents = await readFile(backupPath);
    } catch {
      results.push({
        path: artifact,
        classification: "ambiguous",
        detail:
          "The configuration backup could not be safely inspected and was left unchanged.",
      });
      continue;
    }

    let metadata: ConfigBackupMetadata | undefined;
    try {
      metadata = await readConfigBackupMetadata(path);
    } catch {
      results.push({
        path: artifact,
        classification: "ambiguous",
        detail:
          "Configuration backup metadata is invalid; the artifact was left unchanged.",
      });
      continue;
    }

    if (metadata) {
      if (metadata.backupSha256 !== sha256(backupContents)) {
        results.push({
          path: artifact,
          classification: "ambiguous",
          detail:
            "The backup does not match its transaction metadata and was left unchanged.",
        });
        continue;
      }
      if (!operations) {
        results.push({
          path: artifact,
          classification: "ambiguous",
          detail:
            "The operation journal is unavailable, so transaction completion cannot be established.",
        });
        continue;
      }
      if (metadata.operationId) {
        const pendingOperation = operations.find(
          (operation) => operation.id === metadata.operationId,
        );
        if (
          pendingOperation &&
          (pendingOperation.configPath !== path ||
            pendingOperation.kind !== metadata.operationKind)
        ) {
          results.push({
            path: artifact,
            classification: "ambiguous",
            detail:
              "The backup transaction identifier conflicts with the pending operation and was left unchanged.",
          });
          continue;
        }
      }
      if (metadata.outcome === "in_progress") {
        const relatedOperation = metadata.operationId
          ? operations.find(
              (operation) =>
                operation.id === metadata.operationId &&
                operation.configPath === path,
            )
          : undefined;
        results.push({
          path: artifact,
          classification: "confirmed_incomplete",
          detail: relatedOperation
            ? "Transaction metadata confirms configuration work started; its related operation must be reconciled from live state before this backup can be resolved."
            : "Transaction metadata confirms that configuration work started but has no confirmed outcome.",
          ...(relatedOperation ? { canReconcile: true } : {}),
        });
        continue;
      }
      if (metadata.outcome === "rollback_failed") {
        results.push({
          path: artifact,
          classification: "failed_rollback",
          detail:
            "Transaction metadata confirms that rollback failed; the backup was retained.",
        });
        continue;
      }

      let activeContents: Buffer;
      try {
        activeContents = await readFile(path);
      } catch {
        results.push({
          path: artifact,
          classification: "ambiguous",
          detail:
            "The active configuration is unavailable for confirming the recorded outcome.",
        });
        continue;
      }
      const expectedActiveHash =
        metadata.outcome === "rollback_confirmed"
          ? metadata.backupSha256
          : metadata.activeSha256;
      if (
        !expectedActiveHash ||
        sha256(activeContents) !== expectedActiveHash
      ) {
        results.push({
          path: artifact,
          classification: "ambiguous",
          detail:
            "The active configuration no longer matches the recorded transaction outcome.",
        });
        continue;
      }
      if (metadata.operationId) {
        const pendingOperation = operations.find(
          (operation) => operation.id === metadata.operationId,
        );
        if (pendingOperation) {
          results.push({
            path: artifact,
            classification: "confirmed_incomplete",
            detail:
              "The configuration outcome is confirmed, but its matching operation remains pending and requires reconciliation.",
            canReconcile: true,
          });
          continue;
        }
      }
      const relatedPendingOperation = operations.find(
        (operation) => operation.configPath === path,
      );
      if (relatedPendingOperation) {
        results.push({
          path: artifact,
          classification: "confirmed_incomplete",
          detail:
            "The recorded configuration outcome is valid, but another operation for this configuration remains pending and requires reconciliation.",
          canReconcile: true,
        });
        continue;
      }
      results.push({
        path: artifact,
        classification: "orphaned",
        detail:
          "The recorded configuration transaction outcome is confirmed; its retained backup can be archived explicitly.",
      });
      continue;
    }

    if (!operations) {
      results.push({
        path: artifact,
        classification: "ambiguous",
        detail:
          "The operation journal is unavailable, so the backup's provenance cannot be established.",
      });
      continue;
    }

    const associatedOperation = operations.some(
      (operation) => operation.configPath === path,
    );
    results.push(
      associatedOperation
        ? {
            path: artifact,
            classification: "ambiguous",
            detail:
              "A pending operation may be associated with this backup, but no transaction metadata proves its outcome.",
          }
        : {
            path: artifact,
            classification: "orphaned",
            detail:
              "No corresponding transaction evidence was found; the valid state of this backup must be checked before explicit archival.",
          },
    );
  }
  return results;
}

export async function removeConfigBackup(
  path: string,
  expectedContents: Buffer,
): Promise<void> {
  const backupPath = configBackupPath(path);
  let contents: Buffer;
  try {
    contents = await readFile(backupPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (await readConfigBackupMetadata(path))
        throw new Error(
          "Configuration backup metadata remains without its backup; it was retained for manual inspection.",
        );
      return;
    }
    throw error;
  }
  if (!contents.equals(expectedContents))
    throw new Error(
      "Configuration backup contents changed; the backup was retained for manual inspection.",
    );
  const unresolvedStaging = (await listConfigBackupArtifacts(path)).filter(
    (artifact) =>
      artifact !== backupPath && artifact !== configBackupMetadataPath(path),
  );
  if (unresolvedStaging.length)
    throw new Error(
      "Configuration staging artifacts remain; the backup was retained for manual inspection.",
    );
  const metadata = await readConfigBackupMetadata(path);
  if (
    !metadata ||
    (metadata.outcome !== "commit_confirmed" &&
      metadata.outcome !== "rollback_confirmed")
  )
    throw new Error(
      "Configuration backup has no confirmed outcome; it was retained for manual inspection.",
    );
  await unlink(configBackupMetadataPath(path));
  await unlink(backupPath);
}

export async function restoreConfigFile(
  path: string,
  contents: Buffer,
): Promise<void> {
  const temporary = `${path}.mcpget-${process.pid}-${randomUUID()}.rollback.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await renameWithRetry(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function writeMetadata(
  path: string,
  metadata: ConfigBackupMetadata,
  exclusive = false,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    if (exclusive) {
      await link(temporary, path);
      await chmod(path, 0o600);
      await unlink(temporary);
    } else {
      await renameWithRetry(temporary, path);
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function isConfigBackupMetadata(value: unknown): value is ConfigBackupMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.transactionId === "string" &&
    /^[0-9a-f-]{36}$/i.test(record.transactionId) &&
    (record.operationId === undefined ||
      (typeof record.operationId === "string" &&
        /^[0-9a-f-]{36}$/i.test(record.operationId))) &&
    ["install", "remove", "direct"].includes(String(record.operationKind)) &&
    typeof record.configPath === "string" &&
    typeof record.backupSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(record.backupSha256) &&
    (record.activeSha256 === undefined ||
      (typeof record.activeSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(record.activeSha256))) &&
    [
      "in_progress",
      "commit_confirmed",
      "rollback_confirmed",
      "rollback_failed",
    ].includes(String(record.outcome)) &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}
