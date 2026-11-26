import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, chmod, readFile, stat, unlink } from "node:fs/promises";
import { OperationJournal } from "./operation-journal.js";
import path from "node:path";
import {
  classifyConfigBackupArtifacts,
  configBackupMetadataPath,
  configBackupPath,
  listConfigBackupArtifacts,
  readConfigBackupMetadata,
  removeConfigBackup,
  recordConfigBackupOutcome,
  sha256,
  type ConfigBackupMetadata,
} from "./config-backup.js";
import type { ClientId, ConfigurationScope } from "./types.js";
import { withFileLock } from "./file-lock.js";

export async function ensureConfigBackupLifecycle(
  configPath: string,
  client: ClientId,
  validateConfiguration: (path: string) => Promise<unknown>,
  journal = new OperationJournal(),
  currentOperationId?: string,
  reconcileRelatedOperations?: () => Promise<
    Array<{ status: string; detail: string }>
  >,
): Promise<void> {
  await withFileLock(configPath, async () => {
    const artifacts = await listConfigBackupArtifacts(configPath);
    if (!artifacts.length) return;

    const operations = (await journal.list()).filter(
      (operation) => operation.id !== currentOperationId,
    );
    let assessments = await classifyConfigBackupArtifacts(
      configPath,
      operations,
    );
    const backupPath = configBackupPath(configPath);

    let metadata: ConfigBackupMetadata | undefined;
    let metadataReadFailed = false;
    try {
      metadata = await readConfigBackupMetadata(configPath);
    } catch {
      metadataReadFailed = true;
    }
    const metadataLessRelatedOperation =
      !metadata &&
      !metadataReadFailed &&
      artifacts.length === 1 &&
      artifacts[0] === backupPath &&
      operations.some((operation) => operation.configPath === configPath);
    if (
      reconcileRelatedOperations &&
      (assessments.some((assessment) => assessment.canReconcile) ||
        metadataLessRelatedOperation)
    ) {
      const transactionOperationId = metadata?.operationId;
      const hadPendingConfigOperation =
        transactionOperationId !== undefined &&
        operations.some(
          (operation) =>
            operation.id === transactionOperationId &&
            operation.configPath === configPath,
        );
      const actions = await reconcileRelatedOperations();
      if (actions.some((action) => action.status === "blocked")) {
        const detail = actions
          .filter((action) => action.status === "blocked")
          .map((action) => action.detail)
          .join(" ");
        throw new Error(
          `${detail} Run "mcpget doctor ${client}" to inspect the retained configuration backup and operation state.`,
        );
      }
      const updatedOperations = (await journal.list()).filter(
        (operation) => operation.id !== currentOperationId,
      );
      if (
        metadata?.outcome === "in_progress" &&
        hadPendingConfigOperation &&
        !updatedOperations.some(
          (operation) => operation.configPath === configPath,
        )
      ) {
        try {
          const backupContents = await readFile(backupPath);
          const activeContents = await readFile(configPath);
          if (
            sha256(backupContents) === metadata.backupSha256 &&
            sha256(activeContents) === metadata.backupSha256
          ) {
            await validateConfiguration(configPath);
            await validateConfiguration(backupPath);
            await recordConfigBackupOutcome(
              configPath,
              backupContents,
              "rollback_confirmed",
            );
            metadata = await readConfigBackupMetadata(configPath);
          }
        } catch (error) {
          throw diagnosticResolutionError(client, error);
        }
      }
      assessments = await classifyConfigBackupArtifacts(
        configPath,
        updatedOperations,
      );
    }

    if (
      assessments.length === 1 &&
      assessments[0]?.path === backupPath &&
      assessments[0].classification === "orphaned"
    ) {
      if (metadata) {
        try {
          await validateConfiguration(configPath);
          await validateConfiguration(backupPath);
          await removeConfigBackup(configPath, await readFile(backupPath));
        } catch (error) {
          throw diagnosticResolutionError(client, error);
        }
        return;
      }
      try {
        await archiveOrphanedBackupArtifact(
          configPath,
          client,
          validateConfiguration,
          journal,
          currentOperationId,
        );
      } catch (error) {
        throw diagnosticResolutionError(client, error);
      }
      return;
    }

    const detail = assessments.map((assessment) => assessment.detail).join(" ");
    const recovery = assessments.some((assessment) => assessment.canReconcile)
      ? `Run "mcpget doctor ${client}" and "mcpget recover --yes" to reconcile confirmed operation state.`
      : `Run "mcpget doctor ${client}" to diagnose the retained files.`;
    throw new Error(
      `Unresolved configuration backup artifacts prevent safely changing ${client} configuration: ${detail} ${recovery}`,
    );
  });
}

function diagnosticResolutionError(client: ClientId, error: unknown): Error {
  const reason =
    error instanceof Error
      ? error.message
      : "The backup could not be validated.";
  return new Error(
    `Cannot safely change ${client} configuration: ${reason} Run "mcpget doctor ${client}" to diagnose the retained files.`,
  );
}

export async function archiveOrphanedBackupArtifact(
  configPath: string,
  client: ClientId,
  validateConfiguration: (path: string) => Promise<unknown>,
  journal = new OperationJournal(),
  ignoredOperationId?: string,
): Promise<{ status: "reconciled"; detail: string }> {
  return withFileLock(configPath, async () => {
    const backupPath = configBackupPath(configPath);
    const previousResolutions = await journal.listBackupResolutions();
    if (
      previousResolutions.some(
        (resolution) =>
          resolution.status === "started" &&
          resolution.backupPath === backupPath,
      )
    )
      throw new Error(
        "A previous backup archival operation was interrupted; inspect its recorded paths before retrying.",
      );

    const activeContents = await readFile(configPath);
    await validateConfiguration(configPath);
    const operations = await journal.list();
    const metadata = await readConfigBackupMetadata(configPath).catch(
      () => undefined,
    );
    const relevantOperations = metadata
      ? operations
      : operations.filter((operation) => operation.id !== ignoredOperationId);
    const assessments = await classifyConfigBackupArtifacts(
      configPath,
      relevantOperations,
    );
    if (
      assessments.length !== 1 ||
      assessments[0]?.classification !== "orphaned" ||
      assessments[0].path !== backupPath
    )
      throw new Error(
        "Backup archival is allowed only for a single validated orphaned backup with no ambiguous or incomplete artifacts.",
      );

    const backupContents = await readFile(backupPath);
    await validateConfiguration(backupPath);
    const activeSha256 = sha256(activeContents);
    const backupSha256 = sha256(backupContents);
    const archivePath = `${backupPath}.archive.${randomUUID()}`;
    const metadataPath = configBackupMetadataPath(configPath);
    const metadataArchivePath = `${archivePath}.meta.json`;
    const hasMetadata = await stat(metadataPath).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    const resolution = await journal.beginBackupResolution({
      client,
      configPath,
      backupPath,
      archivePath,
      backupSha256,
      activeSha256,
    });

    try {
      await copyFile(backupPath, archivePath, fsConstants.COPYFILE_EXCL);
      await chmod(archivePath, 0o600);
      if (!(await readFile(archivePath)).equals(backupContents))
        throw new Error("Archived backup could not be verified.");
      await validateConfiguration(archivePath);
      if (sha256(await readFile(configPath)) !== activeSha256)
        throw new Error(
          "Active configuration changed during resolution; the original backup was retained.",
        );
      if (sha256(await readFile(backupPath)) !== backupSha256)
        throw new Error(
          "Configuration backup changed during resolution; the original was retained.",
        );

      if (hasMetadata) {
        await copyFile(
          metadataPath,
          metadataArchivePath,
          fsConstants.COPYFILE_EXCL,
        );
        await chmod(metadataArchivePath, 0o600);
        if (
          !(await readFile(metadataArchivePath)).equals(
            await readFile(metadataPath),
          )
        )
          throw new Error(
            "Archived transaction metadata could not be verified.",
          );
      }
      if (sha256(await readFile(configPath)) !== activeSha256)
        throw new Error(
          "Active configuration changed during resolution; the original backup was retained.",
        );
      if (sha256(await readFile(backupPath)) !== backupSha256)
        throw new Error(
          "Configuration backup changed during resolution; the original was retained.",
        );

      if (hasMetadata) await unlink(metadataPath);
      await unlink(backupPath);
      await journal.finishBackupResolution(resolution.id, "completed");
      return {
        status: "reconciled",
        detail: `Archived the validated orphaned backup for ${client}; the active configuration was not changed.`,
      };
    } catch (error) {
      await journal
        .finishBackupResolution(resolution.id, "failed")
        .catch(() => undefined);
      throw error;
    }
  });
}

export async function validateBackupClientConfiguration(
  client: ClientId,
  displayName: string,
  configPath: string,
  configScope: ConfigurationScope = "user",
): Promise<void> {
  if (client === "codex") {
    const { CodexAdapter } = await import("./codex-adapter.js");
    await new CodexAdapter(
      configPath,
      undefined,
      undefined,
      configScope,
    ).read();
  } else if (client === "claude-code") {
    const { ClaudeCodeAdapter } = await import("./claude-code-adapter.js");
    await new ClaudeCodeAdapter(
      configPath,
      configScope,
      configScope === "project" ? path.dirname(configPath) : undefined,
    ).read();
  } else {
    const { JsonClientAdapter } = await import("./json-client-adapter.js");
    await new JsonClientAdapter(
      client,
      displayName,
      configPath,
      undefined,
      configScope === "local" ? "user" : configScope,
      client === "copilot-vscode"
        ? "mcpServers"
        : client === "copilot-cli"
          ? "auto"
          : "mcpServers",
    ).read();
  }
}
