import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  assertNoConfigBackupArtifacts,
  createConfigBackup,
  removeConfigBackup,
  recordConfigBackupOutcome,
  restoreConfigFile,
  type ConfigBackupContext,
} from "./config-backup.js";
import { renameWithRetry, withFileLock } from "./file-lock.js";

export interface JsonConfigSnapshot {
  value: Record<string, unknown>;
  contents?: Buffer;
}

export interface JsonWriteReceipt {
  previousContents?: Buffer;
  backupPath?: string;
}

export async function readJsonObject(
  path: string,
): Promise<Record<string, unknown>> {
  return (await readJsonSnapshot(path)).value;
}

export async function readJsonSnapshot(
  path: string,
): Promise<JsonConfigSnapshot> {
  let contents: Buffer;
  try {
    contents = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { value: {} };
    throw error;
  }
  return {
    value: parseJsonObject(contents.toString("utf8"), path),
    contents,
  };
}

export function parseJsonObject(
  raw: string,
  path: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      `Configuration at ${path} is not valid JSON; it was left unchanged.`,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Configuration at ${path} must contain a JSON object; it was left unchanged.`,
    );
  }
  return value as Record<string, unknown>;
}

export async function writeJsonSafely(
  path: string,
  value: Record<string, unknown>,
  context: ConfigBackupContext & {
    deferCommitConfirmation?: boolean;
  } = {},
): Promise<JsonWriteReceipt> {
  return withFileLock(path, () => writeJsonUnlocked(path, value, context));
}

async function writeJsonUnlocked(
  path: string,
  value: Record<string, unknown>,
  context: ConfigBackupContext & {
    deferCommitConfirmation?: boolean;
  },
): Promise<JsonWriteReceipt> {
  await mkdir(dirname(path), { recursive: true });
  let previousContents: Buffer | undefined;
  try {
    previousContents = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (previousContents)
    parseJsonObject(previousContents.toString("utf8"), path);
  await assertNoConfigBackupArtifacts(path);
  const backupPath = previousContents
    ? await createConfigBackup(path, previousContents, context)
    : undefined;
  const temp = `${path}.mcpget-${process.pid}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await renameWithRetry(temp, path);
    const verified = await readJsonObject(path);
    if (JSON.stringify(verified) !== JSON.stringify(value))
      throw new Error("Written configuration did not validate.");
    if (backupPath && previousContents && !context.deferCommitConfirmation)
      await recordConfigBackupOutcome(
        path,
        previousContents,
        "commit_confirmed",
      );
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    try {
      if (previousContents) {
        await restoreConfigFile(path, previousContents);
        if (!(await readFile(path)).equals(previousContents))
          throw new Error("Restored configuration did not validate.");
      } else {
        await unlinkIfPresent(path);
        await assertFileAbsent(path);
      }
    } catch (rollbackError) {
      if (backupPath && previousContents)
        await recordConfigBackupOutcome(
          path,
          previousContents,
          "rollback_failed",
        ).catch(() => undefined);
      throw new Error(
        `Configuration write failed and rollback could not be confirmed; recovery backup retained at ${backupPath ?? `${path}.mcpget.bak`}.`,
        { cause: rollbackError },
      );
    }
    if (backupPath && previousContents) {
      try {
        await recordConfigBackupOutcome(
          path,
          previousContents,
          "rollback_confirmed",
        );
        await removeConfigBackup(path, previousContents);
      } catch (cleanupError) {
        throw new Error(
          "Configuration write failed; rollback was confirmed but backup cleanup could not be completed. The backup was retained.",
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
  return {
    ...(previousContents ? { previousContents } : {}),
    ...(backupPath ? { backupPath } : {}),
  };
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertFileAbsent(path: string): Promise<void> {
  try {
    await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("New configuration file remained after rollback.");
}
