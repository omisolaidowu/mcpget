import { basename, dirname } from "node:path";
import { getClientAdaptersForContext } from "./adapters.js";
import { CodexAdapter } from "./codex-adapter.js";
import { JsonClientAdapter } from "./json-client-adapter.js";
import { ClaudeCodeAdapter } from "./claude-code-adapter.js";
import {
  cleanupOrphanedManagedPackage,
  detachManagedAssociation,
  hasManagedPackageReference,
  inspectManagedPackages,
  readManagedPackageMetadata,
  updateManagedMetadata,
} from "./managed-npm.js";
import type {
  ManagedNpmResult,
  ManagedPackageInspection,
} from "./managed-npm.js";
import type { InstallationRecord } from "../models/installation.js";
import { InstallationStateStore } from "./state-store.js";
import { OperationJournal } from "./operation-journal.js";
import type { PendingOperation } from "./operation-journal.js";
import { withFileLock } from "./file-lock.js";
import {
  classifyConfigBackupArtifacts,
  configBackupPath,
  listConfigBackupArtifacts,
  readConfigBackupMetadata,
} from "./config-backup.js";
import type { ConfigBackupMetadata } from "./config-backup.js";
import { archiveOrphanedBackupArtifact } from "./config-backup-lifecycle.js";
import type {
  ClientAdapter,
  ConfigurationScope,
  ServerConfiguration,
} from "./types.js";

export interface RecoveryFinding {
  kind: string;
  detail: string;
  status?:
    | "incomplete"
    | "failed"
    | "configured"
    | "verified"
    | "orphaned"
    | "ambiguous";
  client?: string;
  server?: string;
  path?: string;
  relatedPath?: string;
  operationId?: string;
}

export interface RecoveryAction {
  operationId?: string;
  client?: string;
  configScope?: ConfigurationScope;
  configPath?: string;
  status: "reconciled" | "already_consistent" | "blocked";
  detail: string;
}

export interface RecoveryDependencies {
  adapters?: ClientAdapter[];
  stateStore?: InstallationStateStore;
  journal?: OperationJournal;
  installRoot?: string;
  configPath?: string;
  allowMetadataLessBackupReconciliation?: boolean;
  skipPackageCleanup?: boolean;
  includeUnmatchedOperations?: boolean;
}

export async function inspectRecoveryState(
  dependencies: RecoveryDependencies = {},
): Promise<RecoveryFinding[]> {
  const store = dependencies.stateStore ?? new InstallationStateStore();
  const journal = dependencies.journal ?? new OperationJournal();
  let adapters = dependencies.adapters;
  const configurations = new Map<string, Record<string, ServerConfiguration>>();
  const findings: RecoveryFinding[] = [];
  let operations: PendingOperation[] | undefined;
  try {
    operations = await journal.list();
  } catch {
    findings.push({
      kind: "invalid_recovery_journal",
      status: "failed",
      detail:
        "The recovery journal could not be validated and was left unchanged.",
    });
  }
  if (!adapters)
    adapters = await adaptersForRecovery(operations ?? [], journal);
  try {
    for (const resolution of await journal.listBackupResolutions()) {
      if (resolution.status === "completed") continue;
      findings.push({
        kind:
          resolution.status === "started"
            ? "interrupted_backup_resolution"
            : "failed_backup_resolution",
        status: resolution.status === "started" ? "incomplete" : "failed",
        detail:
          resolution.status === "started"
            ? `A backup archival operation was interrupted; inspect the original backup at ${resolution.backupPath} and the archive copy at ${resolution.archivePath} before further resolution.`
            : `A backup archival attempt failed; inspect the original backup at ${resolution.backupPath} and the archive copy at ${resolution.archivePath} before further resolution.`,
        client: resolution.client,
        path: resolution.backupPath,
        relatedPath: resolution.archivePath,
        operationId: resolution.id,
      });
    }
  } catch {
    findings.push({
      kind: "invalid_backup_resolution_journal",
      status: "failed",
      detail:
        "Backup resolution history could not be validated and was left unchanged.",
    });
  }
  let records: InstallationRecord[];
  try {
    records = await store.all();
  } catch {
    records = [];
    findings.push({
      kind: "invalid_installation_state",
      status: "failed",
      detail:
        "MCPGet installation state could not be validated and was left unchanged.",
    });
  }

  for (const adapter of adapters) {
    try {
      for (const assessment of await classifyConfigBackupArtifacts(
        adapter.configPath(),
        operations,
      )) {
        const kind =
          assessment.classification === "confirmed_incomplete"
            ? "confirmed_incomplete_configuration_transaction"
            : assessment.classification === "failed_rollback"
              ? "confirmed_failed_configuration_rollback"
              : assessment.classification === "orphaned"
                ? "orphaned_configuration_backup"
                : "ambiguous_configuration_backup";
        findings.push({
          kind,
          status:
            assessment.classification === "confirmed_incomplete"
              ? "incomplete"
              : assessment.classification === "failed_rollback"
                ? "failed"
                : assessment.classification,
          detail: assessment.detail,
          client: adapter.id,
          path: assessment.path,
        });
      }
    } catch {
      findings.push({
        kind: "configuration_backup_scan_failed",
        status: "incomplete",
        detail: "Configuration backup artifacts could not be safely inspected.",
        client: adapter.id,
      });
    }
    let servers: Record<string, ServerConfiguration>;
    try {
      servers = await adapter.read();
    } catch {
      findings.push({
        kind: "client_configuration_unavailable",
        status: "incomplete",
        detail:
          "A supported-client configuration could not be inspected for recovery findings.",
        client: adapter.id,
      });
      continue;
    }
    configurations.set(adapter.configPath(), servers);
    for (const name of Object.keys(servers)) {
      if (
        !records.some(
          (record) =>
            record.client === adapter.id &&
            record.configPath === adapter.configPath() &&
            record.configName === name,
        )
      ) {
        findings.push({
          kind: "configuration_without_state",
          status: "configured",
          detail:
            "A client configuration entry has no MCPGet installation record.",
          client: adapter.id,
          server: name,
        });
      }
    }
  }

  for (const record of records) {
    const servers = configurations.get(record.configPath);
    const steps = Object.values(record.states);
    const status = steps.some((step) => step.status === "failed")
      ? "failed"
      : servers?.[record.configName] &&
          record.states.connection_verified.status === "completed"
        ? "verified"
        : servers?.[record.configName] &&
            record.states.configured.status === "completed"
          ? "configured"
          : "incomplete";
    findings.push({
      kind: "installation_state",
      status,
      detail:
        status === "verified"
          ? "MCPGet verified MCP protocol initialization; client loading and authentication are not implied."
          : status === "configured"
            ? "The client configuration is present; MCP connection and authentication are not verified."
            : status === "failed"
              ? "An installation, configuration, or verification step failed."
              : "Installation or configuration is incomplete.",
      client: record.client,
      server: record.configName,
    });
    if (servers && !(record.configName in servers)) {
      findings.push({
        kind: "stale_installation_record",
        status: "incomplete",
        detail:
          "MCPGet has an installation record but the client entry is absent.",
        client: record.client,
        server: record.configName,
      });
    }
  }

  for (const operation of operations ?? []) {
    findings.push({
      kind: "interrupted_operation",
      status: "incomplete",
      detail: `An interrupted ${operation.kind} operation stopped at phase ${operation.phase}.`,
      client: operation.client,
      server: operation.configName,
      ...(operation.installationPath
        ? { path: operation.installationPath }
        : {}),
      operationId: operation.id,
    });
  }

  let packages: ManagedPackageInspection[];
  try {
    packages = await inspectManagedPackages(dependencies.installRoot);
  } catch {
    packages = [];
    findings.push({
      kind: "managed_package_scan_failed",
      status: "incomplete",
      detail: "Managed package directories could not be safely inspected.",
    });
  }
  for (const managed of packages) {
    if (managed.status === "metadata_invalid") {
      findings.push({
        kind: "invalid_managed_metadata",
        status: "failed",
        detail: "Managed package metadata is invalid and was not changed.",
        path: managed.directory,
      });
      continue;
    }
    if (managed.status === "metadata_missing") {
      findings.push({
        kind: "managed_directory_without_metadata",
        status: "incomplete",
        detail:
          "A directory exists in MCPGet's managed package area without valid ownership metadata.",
        path: managed.directory,
      });
      continue;
    }
    let hasReference: boolean;
    try {
      hasReference = await hasManagedPackageReference(
        managed.directory,
        adapters,
      );
    } catch {
      findings.push({
        kind: "managed_references_unverifiable",
        status: "incomplete",
        detail:
          "Supported-client references could not be verified; package cleanup is unsafe.",
        path: managed.directory,
      });
      continue;
    }
    if (!managed.servers?.length && !hasReference) {
      findings.push({
        kind: "orphaned_managed_package",
        status: "orphaned",
        detail:
          "A valid MCPGet package has no recorded associations or supported-client references.",
        path: managed.directory,
      });
    }
    if (
      managed.servers?.length &&
      !managed.servers.some((association) =>
        association.clients.some((client) => {
          const servers = adapters
            .filter((adapter) => adapter.id === client)
            .map((adapter) => configurations.get(adapter.configPath()))
            .find((value) => value !== undefined);
          return (
            servers !== undefined &&
            association.configurationEntries.some((name) => name in servers)
          );
        }),
      )
    ) {
      findings.push({
        kind: "stale_managed_association",
        status: "incomplete",
        detail:
          "Managed package metadata lists server associations absent from supported-client configurations.",
        path: managed.directory,
      });
    }
  }

  return findings;
}

async function adaptersForRecovery(
  operations: PendingOperation[],
  journal: OperationJournal,
): Promise<ClientAdapter[]> {
  const adapters = await getClientAdaptersForContext();
  for (const operation of operations) {
    if (
      adapters.some(
        (adapter) =>
          adapter.id === operation.client &&
          adapter.configPath() === operation.configPath,
      )
    )
      continue;
    if (
      operation.client !== "codex" &&
      operation.client !== "claude" &&
      operation.client !== "claude-code" &&
      operation.client !== "copilot-vscode" &&
      operation.client !== "copilot-cli" &&
      operation.client !== "cursor"
    )
      continue;
    const adapter =
      operation.client === "codex"
        ? new CodexAdapter(
            operation.configPath,
            undefined,
            journal,
            operation.configScope ?? "user",
          )
        : operation.client === "claude-code"
          ? new ClaudeCodeAdapter(
              operation.configPath,
              operation.configScope ?? "local",
              operation.projectRoot,
              journal,
            )
          : operation.client === "copilot-vscode" ||
              operation.client === "copilot-cli"
            ? new JsonClientAdapter(
                operation.client,
                operation.client === "copilot-vscode"
                  ? "GitHub Copilot in VS Code"
                  : "GitHub Copilot CLI",
                operation.configPath,
                journal,
                operation.configScope === "local"
                  ? "user"
                  : (operation.configScope ?? "user"),
                operation.configScope === "project" ? "auto" : "mcpServers",
              )
            : new JsonClientAdapter(
                operation.client,
                operation.client === "claude" ? "Claude Desktop" : "Cursor",
                operation.configPath,
              );
    adapters.push(adapter);
  }
  return adapters;
}

export async function recoverPendingOperations(
  dependencies: RecoveryDependencies = {},
): Promise<RecoveryAction[]> {
  const store = dependencies.stateStore ?? new InstallationStateStore();
  const journal = dependencies.journal ?? new OperationJournal();
  const operations = await journal.list();
  const actions: RecoveryAction[] = [];
  const adapters = dependencies.adapters
    ? dependencies.adapters
    : await adaptersForRecovery(operations, journal);
  const adaptersWithBlockingBackupArtifacts = new Set<string>();
  for (const adapter of adapters) {
    const assessments = await classifyConfigBackupArtifacts(
      adapter.configPath(),
      operations,
    );
    let mayReconcileMetadataLessBackup = false;
    if (
      dependencies.allowMetadataLessBackupReconciliation &&
      dependencies.configPath === adapter.configPath()
    ) {
      const artifacts = await listConfigBackupArtifacts(adapter.configPath());
      let metadata: ConfigBackupMetadata | undefined;
      let metadataReadFailed = false;
      try {
        metadata = await readConfigBackupMetadata(adapter.configPath());
      } catch {
        metadataReadFailed = true;
      }
      mayReconcileMetadataLessBackup =
        !metadata &&
        !metadataReadFailed &&
        artifacts.length === 1 &&
        artifacts[0] === configBackupPath(adapter.configPath()) &&
        operations.some(
          (operation) => operation.configPath === adapter.configPath(),
        );
    }
    const blocking = assessments.filter(
      (assessment) =>
        assessment.classification !== "orphaned" && !assessment.canReconcile,
    );
    const safelyScopedMetadataLessBlock =
      mayReconcileMetadataLessBackup &&
      blocking.every(
        (assessment) =>
          assessment.path === configBackupPath(adapter.configPath()) &&
          assessment.classification === "ambiguous",
      );
    if (!blocking.length || safelyScopedMetadataLessBlock) continue;
    adaptersWithBlockingBackupArtifacts.add(
      `${adapter.id}\0${adapter.configPath()}`,
    );
    actions.push({
      status: "blocked",
      detail: `Configuration backup artifacts require resolution (${blocking.map((assessment) => basename(assessment.path)).join(", ")}); recovery did not restore or delete them.`,
    });
  }

  const scopedAdapter = dependencies.configPath
    ? adapters.find(
        (adapter) => adapter.configPath() === dependencies.configPath,
      )
    : undefined;
  const operationsToRecover = operations.filter((operation) => {
    if (
      dependencies.configPath &&
      (operation.configPath !== dependencies.configPath ||
        operation.client !== scopedAdapter?.id)
    )
      return false;
    return dependencies.adapters
      ? adapters.some(
          (adapter) =>
            adapter.id === operation.client &&
            adapter.configPath() === operation.configPath,
        )
      : true;
  });
  if (dependencies.includeUnmatchedOperations) {
    const recoverableIds = new Set(
      operationsToRecover.map((operation) => operation.id),
    );
    for (const operation of operations) {
      if (recoverableIds.has(operation.id)) continue;
      actions.push({
        operationId: operation.id,
        client: operation.client,
        configScope: operation.configScope ?? "user",
        configPath: operation.configPath,
        status: "blocked",
        detail:
          "The operation references a configuration scope that is not available in the current project/profile context; the journal entry was retained.",
      });
    }
  }
  for (const operation of operationsToRecover) {
    const adapter = adapters.find(
      (item) =>
        item.id === operation.client &&
        item.configPath() === operation.configPath,
    );
    if (!adapter) {
      actions.push({
        operationId: operation.id,
        status: "blocked",
        detail:
          "The operation references an unsupported client; the journal entry was retained.",
      });
      continue;
    }

    await withFileLock(adapter.configPath(), async () => {
      if (
        adaptersWithBlockingBackupArtifacts.has(
          `${adapter.id}\0${adapter.configPath()}`,
        )
      ) {
        actions.push({
          operationId: operation.id,
          status: "blocked",
          detail:
            "Configuration backup artifacts remain unresolved; the operation journal and files were left unchanged.",
        });
        return;
      }
      const current = await adapter.read();
      const entryExists = operation.configName in current;
      const records = await store.all();
      const record = records.find(
        (item) =>
          item.client === operation.client &&
          item.configPath === operation.configPath &&
          item.serverIdentifier === operation.serverIdentifier &&
          item.configName === operation.configName,
      );

      if (operation.kind === "remove") {
        if (entryExists) {
          if (!record) {
            actions.push({
              operationId: operation.id,
              status: "blocked",
              detail:
                "The configuration entry still exists but its installation record is missing; the journal was retained.",
            });
            return;
          }
          await journal.complete(operation.id);
          actions.push({
            operationId: operation.id,
            status: "already_consistent",
            detail:
              "The configuration entry remains present; removal was not completed and no files were changed.",
          });
          return;
        }

        if (record)
          await store.delete(record.id, record.client, operation.configPath);
        if (operation.installationPath) {
          await detachManagedAssociation(
            operation.installationPath,
            operation.serverIdentifier,
            operation.client,
            operation.configName,
            dependencies.installRoot,
          );
          await cleanupOrphanedManagedPackage(
            operation.installationPath,
            dependencies.installRoot,
            adapters,
          );
        }
        await journal.complete(operation.id);
        actions.push({
          operationId: operation.id,
          status: "reconciled",
          detail:
            "The client entry is absent; stale state and association data were reconciled without editing client configuration.",
        });
        return;
      }

      if (!entryExists) {
        if (record) {
          record.states.configured = {
            status: "failed",
            detail:
              "Recovery found no corresponding client configuration entry.",
            at: new Date().toISOString(),
          };
          record.states.connection_verified = {
            status: "not_verified",
            detail: "Connection was not verified during recovery.",
            at: new Date().toISOString(),
          };
          record.lastError =
            "Interrupted installation has no corresponding client configuration entry.";
          await store.put(record);
        }
        if (operation.installationPath) {
          await detachManagedAssociation(
            operation.installationPath,
            operation.serverIdentifier,
            operation.client,
            operation.configName,
            dependencies.installRoot,
          );
        }
        await journal.complete(operation.id);
        actions.push({
          operationId: operation.id,
          status: "reconciled",
          detail:
            "The client entry is absent; incomplete state and package association data were reconciled. Any package cleanup is separately reported after ownership and reference checks.",
        });
        return;
      }

      if (!record) {
        actions.push({
          operationId: operation.id,
          status: "blocked",
          detail:
            "The client entry exists but its installation record is missing; the journal was retained.",
        });
        return;
      }

      const entry = current[operation.configName]!;
      if (operation.installationPath) {
        const metadata = await readManagedPackageMetadata(
          operation.installationPath,
        );
        if (
          !metadata ||
          !entryReferencesPackage(entry, operation.installationPath)
        ) {
          actions.push({
            operationId: operation.id,
            status: "blocked",
            detail:
              "The client entry cannot be matched to valid managed package metadata; the journal was retained.",
          });
          return;
        }
        const result: ManagedNpmResult = {
          directory: operation.installationPath,
          packageIdentifier: metadata.packageIdentifier,
          installedVersion: metadata.installedVersion,
          command: entry.command ?? "",
          args: entry.args ?? [],
          reused: true,
          lifecycleScriptsEnabled: metadata.lifecycleScriptsEnabled === true,
        };
        await updateManagedMetadata(result, {
          serverIdentifier: operation.serverIdentifier,
          serverName: record.displayName,
          client: operation.client,
          configurationEntry: operation.configName,
          verificationStatus: "recovered_configuration_present",
        });
      }
      record.states.configured = {
        status: "completed",
        detail: "The client configuration entry was re-read during recovery.",
        at: new Date().toISOString(),
      };
      record.states.connection_verified = {
        status: "not_verified",
        detail:
          "MCP connection and authentication were not verified during recovery.",
        at: new Date().toISOString(),
      };
      record.states.authenticated = {
        status: "not_verified",
        detail:
          "Authentication was not independently verified during recovery.",
        at: new Date().toISOString(),
      };
      await store.put(record);
      await journal.complete(operation.id);
      actions.push({
        operationId: operation.id,
        status: "reconciled",
        detail:
          "The existing client entry and managed package association were reconciled; connection and authentication remain unverified.",
      });
    });
  }

  if (dependencies.skipPackageCleanup || dependencies.configPath)
    return includeRecoveryScope(actions, operationsToRecover);

  for (const managed of await inspectManagedPackages(
    dependencies.installRoot,
  )) {
    if (managed.status !== "valid" || managed.servers?.length) continue;
    if (
      await cleanupOrphanedManagedPackage(
        managed.directory,
        dependencies.installRoot,
        adapters,
      )
    ) {
      actions.push({
        status: "reconciled",
        detail:
          "Removed a validated orphaned managed package after confirming no supported-client configuration references it.",
      });
    }
  }
  return includeRecoveryScope(actions, operationsToRecover);
}

function includeRecoveryScope(
  actions: RecoveryAction[],
  operations: PendingOperation[],
): RecoveryAction[] {
  return actions.map((action) => {
    const operation = operations.find((item) => item.id === action.operationId);
    return operation
      ? {
          ...action,
          client: operation.client,
          configScope: operation.configScope ?? "user",
          configPath: operation.configPath,
        }
      : action;
  });
}

export async function archiveOrphanedConfigBackup(
  adapter: ClientAdapter,
  journal = new OperationJournal(),
): Promise<RecoveryAction> {
  return withFileLock(adapter.configPath(), async () => {
    const backupPath = configBackupPath(adapter.configPath());
    if (!(await listConfigBackupArtifacts(adapter.configPath())).length) {
      const completedResolution = (await journal.listBackupResolutions()).some(
        (resolution) =>
          resolution.backupPath === backupPath &&
          resolution.status === "completed",
      );
      if (completedResolution)
        return {
          status: "already_consistent",
          detail:
            "The validated orphaned backup was already archived; the active configuration remains unchanged.",
        };
    }

    const result = await archiveOrphanedBackupArtifact(
      adapter.configPath(),
      adapter.id,
      async (configPath) => {
        const validationAdapter =
          adapter.id === "codex"
            ? new CodexAdapter(
                configPath,
                undefined,
                undefined,
                adapter.configScope(),
              )
            : adapter.id === "claude-code"
              ? new ClaudeCodeAdapter(
                  configPath,
                  adapter.configScope(),
                  adapter.configScope() === "project"
                    ? dirname(configPath)
                    : undefined,
                )
              : new JsonClientAdapter(
                  adapter.id,
                  adapter.displayName,
                  configPath,
                );
        await validationAdapter.read();
      },
      journal,
    );
    return { status: result.status, detail: result.detail };
  });
}

function entryReferencesPackage(
  entry: ServerConfiguration,
  packageDirectory: string,
): boolean {
  const root = packageDirectory.replace(/[\\/]+$/, "");
  const candidates = [entry.command, ...(entry.args ?? [])].filter(
    (value): value is string => typeof value === "string",
  );
  return candidates.some(
    (value) =>
      value === root ||
      value.startsWith(`${root}/`) ||
      value.startsWith(`${root}\\`),
  );
}
