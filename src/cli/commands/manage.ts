import type { Command } from "commander";
import type { Writable } from "node:stream";
import path from "node:path";
import {
  getClientAdapter,
  getClientAdaptersForContext,
  getCodexAdaptersForContext,
} from "../../installers/adapters.js";
import type {
  ClientAdapter,
  ServerConfiguration,
} from "../../installers/types.js";
import { InstallationStateStore } from "../../installers/state-store.js";
import {
  CliError,
  EXIT_CODES,
  exitCodeForError,
  failureResponse,
  printJson,
  safeTerminalText,
  successResponse,
} from "../output.js";
import { releaseManagedAssociation } from "../../installers/managed-npm.js";
import { withFileLock } from "../../installers/file-lock.js";
import { OperationJournal } from "../../installers/operation-journal.js";
import {
  ensureConfigBackupLifecycle,
  validateBackupClientConfiguration,
} from "../../installers/config-backup-lifecycle.js";
import {
  archiveOrphanedConfigBackup,
  inspectRecoveryState,
  recoverPendingOperations,
} from "../../installers/recovery.js";
import { redactEndpointCredentials } from "../../security/remote-endpoint.js";
import {
  chooseCodexTarget,
  requireCodexScope,
  resolveCodexTargets,
  codexAdapterForTarget,
} from "../codex-target.js";
import { ClaudeCodeAdapter } from "../../installers/claude-code-adapter.js";
import { resolveClaudeCodeScopeContext } from "../../installers/claude-code-scopes.js";
import { JsonClientAdapter } from "../../installers/json-client-adapter.js";
import { resolveCopilotScopeContext } from "../../installers/copilot-scopes.js";

export function registerManagementCommands(program: Command): void {
  const clients = program
    .command("clients")
    .description("Show supported MCP clients and configuration status")
    .option("--json", "print stable JSON output");
  clients.action(async () => {
    const json = clients.opts().json === true;
    const clientRows: Array<{
      id: string;
      status: string;
      displayName: string;
      configPath: string;
    }> = [];
    const adapters = await getClientAdaptersForContext();
    const codexScopes = await codexScopeDisclosure();
    for (const adapter of adapters) {
      let configured = false;
      let detectionError: string | undefined;
      try {
        configured = await adapter.detect();
      } catch (error) {
        detectionError =
          error instanceof Error
            ? error.message
            : "configuration is unavailable";
      }
      const status = detectionError
        ? `${adapter.configScope()} configuration unavailable`
        : adapter.id === "codex" && adapter.configScope() === "user"
          ? configured
            ? "User configuration present"
            : "User configuration not found; app presence is unknown"
          : configured
            ? `${adapter.configScope()} configuration present`
            : `${adapter.configScope()} configuration not found; app presence is unknown`;
      clientRows.push({
        id: adapter.id,
        status: detectionError
          ? `${status}: ${safeTerminalText(detectionError, 200)}`
          : status,
        displayName: adapter.displayName,
        configPath: adapter.configPath(),
      });
      if (!json)
        console.log(
          `${adapter.id}\t${status}\t${adapter.configScope()}\t${adapter.displayName}\t${safeTerminalText(adapter.configPath(), 300)}`,
        );
    }
    if (json)
      printJson(
        successResponse("clients", {
          clients: clientRows,
          codexScopes,
        }),
      );
    else {
      for (const warning of codexScopes.notInspected)
        console.log(`Codex scope not inspected: ${safeTerminalText(warning)}`);
      console.log(
        "Claude remote connectors are managed in Claude settings; Codex user configuration is managed directly.",
      );
    }
  });

  const list = program
    .command("list [client]")
    .description("List MCP servers configured for supported clients")
    .option("--json", "print stable JSON output")
    .option(
      "--scope <scope>",
      "filter Codex configuration scope: user or project",
    )
    .option("--config <path>", "inspect one exact Codex config.toml")
    .option("--codex-profile <profile>", "include a named Codex profile");
  list.action(async (clientId?: string) => {
    const options = list.opts() as {
      json?: boolean;
      scope?: string;
      config?: string;
      codexProfile?: string;
    };
    const json = options.json === true;
    try {
      const adapters = await managementAdapters(clientId, options);
      const codexScopes =
        (!clientId || clientId.toLowerCase() === "codex") &&
        !options.scope &&
        !options.config
          ? await codexScopeDisclosure(options.codexProfile)
          : undefined;
      const records = await new InstallationStateStore().all().catch(() => []);
      let count = 0;
      const servers: Array<{
        name: string;
        client: string;
        status: string;
        configuration: string;
        scope: string;
        configPath: string;
      }> = [];
      for (const adapter of adapters) {
        for (const [name, value] of Object.entries(
          await readManagementServers(adapter, true),
        )) {
          count += 1;
          const record = records.find(
            (item) =>
              item.client === adapter.id &&
              item.configPath === adapter.configPath() &&
              item.configName === name,
          );
          const status =
            adapter.id === "claude-code" &&
            adapter.configScope() === "project" &&
            (await adapter.projectApprovalStatus?.(name)) === "pending"
              ? "Project-scoped configuration pending Claude Code approval"
              : adapter.id === "claude-code" &&
                  adapter.configScope() === "project" &&
                  (await adapter.projectApprovalStatus?.(name)) === "disabled"
                ? "Project-scoped configuration disabled by Claude Code"
                : record?.states.connection_verified.status === "completed"
                  ? "MCP protocol initialized by MCPGet; client runtime not verified"
                  : record?.states.installed.status === "completed"
                    ? "Managed package installed; connection not verified"
                    : record?.states.authenticated.status ===
                        "authentication_required"
                      ? "Authentication required"
                      : record?.lastError
                        ? "Setup/verification failed"
                        : "Configured; connection unknown";
          const configuration = safeTerminalText(
            value.url
              ? redactEndpointCredentials(value.url)
              : (value.command ?? "configuration present"),
          );
          servers.push({
            name: safeTerminalText(name),
            client: adapter.id,
            status,
            configuration,
            scope: adapter.configScope(),
            configPath: safeTerminalText(adapter.configPath(), 500),
          });
          if (!json)
            console.log(
              `${safeTerminalText(name)}\t${adapter.id}\t${adapter.configScope()}\t${status}\t${configuration}\t${safeTerminalText(adapter.configPath(), 300)}`,
            );
        }
      }
      if (json)
        printJson(
          successResponse("list", {
            count,
            servers,
            ...(codexScopes ? { codexScopes } : {}),
          }),
        );
      else {
        if (codexScopes)
          console.log(
            `Codex scopes inspected: ${codexScopes.inspected.map((item) => `${item.scope} (${safeTerminalText(item.configPath, 300)})`).join(", ") || "none"}`,
          );
        for (const warning of codexScopes?.notInspected ?? [])
          console.log(
            `Codex scope not inspected: ${safeTerminalText(warning)}`,
          );
        if (!count) console.log("No configured MCP servers found.");
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "client configuration could not be read";
      const cliError =
        clientId && /Unsupported client/.test(message)
          ? new CliError("UNSUPPORTED_OPERATION", message)
          : new CliError("OPERATIONAL_FAILURE", message);
      if (json) printJson(failureResponse("list", cliError));
      else console.error(`List failed: ${safeTerminalText(message)}`);
      process.exitCode = exitCodeForError(cliError);
    }
  });

  const remove = program
    .command("remove <server> <client>")
    .description("Remove an MCP server entry from one client")
    .option("--json", "print the operation result as JSON")
    .option("--yes", "explicitly approve the removal")
    .option("--scope <scope>", "Codex configuration scope: user or project")
    .option("--config <path>", "target one exact Codex config.toml")
    .option("--codex-profile <profile>", "include a named Codex profile");
  remove.action(async (name: string, clientId: string) => {
    const options = remove.opts() as {
      json?: boolean;
      yes?: boolean;
      scope?: string;
      config?: string;
      codexProfile?: string;
    };
    const json = options.json === true;
    try {
      const scope =
        clientId.toLowerCase() === "copilot-vscode" ||
        clientId.toLowerCase() === "copilot-cli"
          ? options.scope === undefined
            ? undefined
            : options.scope === "user" || options.scope === "project"
              ? options.scope
              : (() => {
                  throw new CliError(
                    "INVALID_INPUT",
                    "Unsupported Copilot scope. Choose user or project.",
                  );
                })()
          : clientId.toLowerCase() === "claude-code"
            ? options.scope === undefined
              ? undefined
              : options.scope === "user" ||
                  options.scope === "project" ||
                  options.scope === "local"
                ? options.scope
                : (() => {
                    throw new CliError(
                      "INVALID_INPUT",
                      "Unsupported Claude Code scope. Choose user, project, or local.",
                    );
                  })()
            : requireCodexScope(options.scope);
      const store = new InstallationStateStore();
      const records = await store.all();
      let adapter: ClientAdapter;
      let record: (typeof records)[number] | undefined;
      let configName: string;
      if (clientId.toLowerCase() === "codex") {
        const resolved = await resolveCodexTargets({
          ...(scope ? { scope } : {}),
          ...(options.config ? { config: options.config } : {}),
          ...(options.codexProfile
            ? { codexProfile: options.codexProfile }
            : {}),
        });
        const targetAdapters = resolved.adapters.filter(
          (item) =>
            (!scope || item.configScope() === scope) &&
            (!options.config ||
              path.resolve(item.configPath()) === path.resolve(options.config)),
        );
        const matches: Array<{
          adapter: ClientAdapter;
          configName: string;
          record?: (typeof records)[number];
        }> = [];
        for (const candidate of targetAdapters) {
          const candidateRecord = records.find(
            (item) =>
              item.client === "codex" &&
              item.configPath === candidate.configPath() &&
              (item.id === name ||
                item.serverIdentifier === name ||
                item.configName === name),
          );
          const candidateName = candidateRecord?.configName ?? name;
          if (candidateName in (await readManagementServers(candidate, true)))
            matches.push({
              adapter: candidate,
              configName: candidateName,
              ...(candidateRecord ? { record: candidateRecord } : {}),
            });
        }
        if (matches.length > 1) {
          const target = await chooseCodexTarget(
            matches.map((match) => ({
              path: match.adapter.configPath(),
              scope: match.adapter.configScope(),
            })),
            json,
          );
          const selected = matches.find(
            (match) => match.adapter.configPath() === target.path,
          );
          if (!selected)
            throw new Error("The selected Codex configuration is unavailable.");
          adapter = selected.adapter;
          record = selected.record;
          configName = selected.configName;
        } else if (matches.length === 1) {
          adapter = matches[0]!.adapter;
          record = matches[0]!.record;
          configName = matches[0]!.configName;
        } else {
          adapter = resolved.adapters[0] ?? getClientAdapter(clientId);
          record = undefined;
          configName = name;
        }
      } else if (
        clientId.toLowerCase() === "copilot-vscode" ||
        clientId.toLowerCase() === "copilot-cli"
      ) {
        const adapters = await managementAdapters(
          clientId.toLowerCase(),
          options,
        );
        const matches: Array<{
          adapter: ClientAdapter;
          configName: string;
          record?: (typeof records)[number];
        }> = [];
        for (const candidate of adapters) {
          const candidateRecord = records.find(
            (item) =>
              (item.client === "copilot-vscode" ||
                item.client === "copilot-cli") &&
              item.configPath === candidate.configPath() &&
              (item.id === name ||
                item.serverIdentifier === name ||
                item.configName === name),
          );
          const candidateName = candidateRecord?.configName ?? name;
          if (candidateName in (await readManagementServers(candidate, true)))
            matches.push({
              adapter: candidate,
              configName: candidateName,
              ...(candidateRecord ? { record: candidateRecord } : {}),
            });
        }
        if (matches.length === 1) {
          adapter = matches[0]!.adapter;
          record = matches[0]!.record;
          configName = matches[0]!.configName;
        } else if (matches.length > 1) {
          throw new CliError(
            "INVALID_INPUT",
            `Server ${name} exists in multiple Copilot targets. Select --scope user|project or --config explicitly.`,
          );
        } else {
          adapter =
            adapters.find((item) => item.configScope() === (scope ?? "user")) ??
            adapters[0]!;
          if (!adapter)
            throw new CliError(
              "INVALID_INPUT",
              "No Copilot configuration target is available.",
            );
          const found = await adapter.read();
          if (!(name in found))
            throw new CliError(
              "INVALID_INPUT",
              `No server named ${name} is configured for ${adapter.displayName} in the selected target.`,
            );
          record = undefined;
          configName = name;
        }
      } else if (clientId.toLowerCase() === "claude-code") {
        const adapters = await managementAdapters("claude-code", options);
        const matches: Array<{
          adapter: ClientAdapter;
          configName: string;
          record?: (typeof records)[number];
        }> = [];
        for (const candidate of adapters) {
          const candidateRecord = records.find(
            (item) =>
              item.client === "claude-code" &&
              item.configPath === candidate.configPath() &&
              item.configScope === candidate.configScope() &&
              (item.id === name ||
                item.serverIdentifier === name ||
                item.configName === name),
          );
          const candidateName = candidateRecord?.configName ?? name;
          if (candidateName in (await readManagementServers(candidate, true)))
            matches.push({
              adapter: candidate,
              configName: candidateName,
              ...(candidateRecord ? { record: candidateRecord } : {}),
            });
        }
        if (matches.length === 1) {
          adapter = matches[0]!.adapter;
          record = matches[0]!.record;
          configName = matches[0]!.configName;
        } else if (matches.length > 1) {
          throw new CliError(
            "INVALID_INPUT",
            `Server ${name} exists in multiple Claude Code scopes. Select --scope user|project|local explicitly.`,
          );
        } else {
          adapter =
            adapters.find(
              (item) => item.configScope() === (scope ?? "local"),
            ) ?? adapters[0]!;
          if (!adapter)
            throw new CliError(
              "INVALID_INPUT",
              "No Claude Code configuration scope is available.",
            );
          record = undefined;
          configName = name;
          const found = await adapter.read();
          if (!(configName in found))
            throw new CliError(
              "INVALID_INPUT",
              `No server named ${name} is configured for Claude Code in the selected scope.`,
            );
        }
      } else {
        if (scope || options.config || options.codexProfile)
          throw new CliError(
            "INVALID_INPUT",
            "Codex scope, config, and profile options are supported only when removing from Codex.",
          );
        adapter = getClientAdapter(clientId);
        const servers = await adapter.read();
        record = records.find(
          (item) =>
            item.client === adapter.id &&
            (item.id === name ||
              item.serverIdentifier === name ||
              item.configName === name),
        );
        configName = record?.configName ?? name;
        if (!(configName in servers)) record = undefined;
      }
      if (!record && clientId.toLowerCase() === "codex") {
        const found = await adapter.read();
        if (!(configName in found)) {
          const error = new CliError(
            "INVALID_INPUT",
            `No server named ${name} is configured for ${adapter.displayName} in the selected scope.`,
          );
          if (json) printJson(failureResponse("remove", error));
          else console.error(safeTerminalText(error.message));
          process.exitCode = exitCodeForError(error);
          return;
        }
      }
      if (!options.yes) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw new CliError(
            "MISSING_REQUIRED_INPUT",
            "Non-interactive removal requires explicit --yes approval.",
          );
        }
        if (
          !(await confirm(
            "Remove this configuration entry? [y/N] ",
            json ? process.stderr : process.stdout,
          ))
        ) {
          if (!json) console.log("Cancelled; no changes made.");
          if (json)
            printJson(
              failureResponse(
                "remove",
                new CliError(
                  "CANCELLED",
                  "Removal was cancelled. No changes were made.",
                ),
              ),
            );
          process.exitCode = EXIT_CODES.cancelled;
          return;
        }
      }
      const journal = new OperationJournal();
      await withFileLock(adapter.configPath(), async () => {
        const latestServers = await adapter.read();
        const latestRecords = await store.all();
        const latestRecord = latestRecords.find(
          (item) =>
            item.client === adapter.id &&
            item.configPath === adapter.configPath() &&
            (item.id === name ||
              item.serverIdentifier === name ||
              item.configName === name),
        );
        const latestConfigName = latestRecord?.configName ?? name;
        if (!(latestConfigName in latestServers)) {
          throw new CliError(
            "INVALID_INPUT",
            `No server named ${name} is configured for ${adapter.displayName}.`,
          );
        }
        await ensureConfigBackupLifecycle(
          adapter.configPath(),
          adapter.id,
          (configPath) =>
            validateBackupClientConfiguration(
              adapter.id,
              adapter.displayName,
              configPath,
              adapter.configScope(),
            ),
          journal,
          undefined,
          () =>
            recoverPendingOperations({
              adapters: [adapter],
              configPath: adapter.configPath(),
              allowMetadataLessBackupReconciliation: true,
              skipPackageCleanup: true,
              journal,
            }),
        );
        const operation = await journal.begin({
          kind: "remove",
          client: adapter.id,
          configPath: adapter.configPath(),
          configScope: adapter.configScope(),
          ...(latestRecord?.projectRoot
            ? { projectRoot: latestRecord.projectRoot }
            : {}),
          configName: latestConfigName,
          serverIdentifier: latestRecord?.serverIdentifier ?? name,
          ...(latestRecord?.installationPath
            ? { installationPath: latestRecord.installationPath }
            : {}),
          ...(latestRecord?.packageIdentifier
            ? { packageIdentifier: latestRecord.packageIdentifier }
            : {}),
        });
        if (!(await adapter.remove(latestConfigName, operation.id))) {
          await journal.complete(operation.id);
          const error = new CliError(
            "OPERATIONAL_FAILURE",
            `${adapter.displayName} did not remove ${latestConfigName}.`,
          );
          if (json) printJson(failureResponse("remove", error));
          else
            console.error(`Remove failed: ${safeTerminalText(error.message)}`);
          process.exitCode = exitCodeForError(error);
          return;
        }
        let packageRemoved = false;
        let packageKept = false;
        if (!(await adapter.verifyRemoved(latestConfigName)))
          throw new Error(
            `${adapter.displayName} still reports ${latestConfigName} after the removal command.`,
          );
        await journal.advance(operation.id, "configuration_written");
        if (latestRecord)
          await store.delete(latestRecord.id, adapter.id, adapter.configPath());
        await journal.advance(operation.id, "state_updated");
        if (
          latestRecord?.strategy === "managed" &&
          latestRecord.installationPath
        ) {
          let removedFiles: boolean;
          try {
            removedFiles = await releaseManagedAssociation(
              latestRecord.installationPath,
              latestRecord.serverIdentifier,
              adapter.id,
              latestConfigName,
            );
          } catch (error) {
            const detail =
              error instanceof Error
                ? error.message
                : "Managed package cleanup could not be completed.";
            throw new Error(
              `The client configuration entry was removed, but managed package cleanup failed: ${detail}`,
            );
          }
          packageRemoved = removedFiles;
          packageKept = !removedFiles;
          await journal.advance(operation.id, "metadata_updated");
          if (!json)
            console.log(
              removedFiles
                ? "Removed the unused MCPGet-managed package."
                : "Kept the managed package because another client/server still references it.",
            );
        }
        await journal.complete(operation.id);
        if (json) {
          printJson(
            successResponse("remove", {
              server: safeTerminalText(latestConfigName),
              client: adapter.id,
              scope: adapter.configScope(),
              configPath: safeTerminalText(adapter.configPath(), 500),
              removed: true,
              ...(latestRecord?.strategy === "managed"
                ? { packageRemoved, packageKept }
                : { packageRemoved: false }),
            }),
          );
        } else {
          console.log(
            `Removed ${safeTerminalText(latestConfigName)} from ${adapter.displayName}. Target: ${adapter.configScope()} scope at ${safeTerminalText(adapter.configPath(), 300)}.`,
          );
        }
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Server removal failed.";
      const cliError =
        error instanceof CliError
          ? error
          : /Unsupported client/.test(message)
            ? new CliError("UNSUPPORTED_OPERATION", message)
            : /Interactive confirmation is required/.test(message)
              ? new CliError("MISSING_REQUIRED_INPUT", message)
              : new CliError("OPERATIONAL_FAILURE", message);
      if (json) printJson(failureResponse("remove", cliError));
      else console.error(`Remove failed: ${safeTerminalText(message)}`);
      process.exitCode = exitCodeForError(cliError);
    }
  });

  const doctor = program
    .command("doctor [client]")
    .description("Check client configuration and runtime availability")
    .option("--json", "print stable JSON output")
    .option(
      "--scope <scope>",
      "filter Codex configuration scope: user or project",
    )
    .option("--config <path>", "inspect one exact Codex config.toml")
    .option("--codex-profile <profile>", "include a named Codex profile");
  doctor.action(async (clientId?: string) => {
    const options = doctor.opts() as {
      json?: boolean;
      scope?: string;
      config?: string;
      codexProfile?: string;
    };
    const json = options.json === true;
    try {
      const adapters = await managementAdapters(clientId, options);
      const codexScopes =
        (!clientId || clientId.toLowerCase() === "codex") &&
        !options.scope &&
        !options.config
          ? await codexScopeDisclosure(options.codexProfile)
          : undefined;
      const diagnostics = [];
      const allowMissingCodexScopes =
        (!clientId || clientId.toLowerCase() === "codex") &&
        !options.scope &&
        !options.config &&
        (
          await Promise.all(
            adapters
              .filter((adapter) => adapter.id === "codex")
              .map((adapter) => adapter.detect()),
          )
        ).some(Boolean);
      for (const adapter of adapters)
        diagnostics.push(
          await diagnose(
            adapter,
            json,
            allowMissingCodexScopes && adapter.id === "codex",
          ),
        );
      const recovery = await inspectRecoveryState({ adapters });
      const recoveryWarnings = recovery
        .filter((finding) => finding.kind !== "installation_state")
        .map((finding) => finding.detail);
      if (!json)
        for (const finding of recovery)
          console.log(
            finding.kind === "installation_state"
              ? `Installation state: ${finding.status} (${finding.client}: ${safeTerminalText(finding.server ?? "unknown")})`
              : `Recovery finding: ${finding.kind}: ${safeTerminalText(finding.detail)}`,
          );
      if (!json)
        for (const warning of codexScopes?.notInspected ?? [])
          console.log(
            `Codex scope not inspected: ${safeTerminalText(warning)}`,
          );
      const failures = diagnostics.filter((item) => !item.ok);
      if (json) {
        if (failures.length) {
          const message = failures.map((item) => item.message).join(" ");
          printJson(
            failureResponse(
              "doctor",
              new CliError("OPERATIONAL_FAILURE", message),
              recoveryWarnings,
              {
                diagnostics,
                recovery,
                ...(codexScopes ? { codexScopes } : {}),
              },
            ),
          );
          process.exitCode = EXIT_CODES.operationalFailure;
        } else {
          printJson(
            successResponse(
              "doctor",
              {
                diagnostics,
                recovery,
                ...(codexScopes ? { codexScopes } : {}),
              },
              recoveryWarnings,
            ),
          );
        }
      } else if (failures.length) {
        process.exitCode = EXIT_CODES.operationalFailure;
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Client diagnostics failed.";
      const cliError =
        clientId && /Unsupported client/.test(message)
          ? new CliError("UNSUPPORTED_OPERATION", message)
          : new CliError("OPERATIONAL_FAILURE", message);
      if (json) printJson(failureResponse("doctor", cliError));
      else console.error(`Doctor failed: ${safeTerminalText(message)}`);
      process.exitCode = exitCodeForError(cliError);
    }
  });

  const recover = program
    .command("recover")
    .description(
      "Reconcile interrupted operations and safely clean validated orphan packages",
    )
    .option("--json", "print stable JSON output")
    .option("--yes", "explicitly approve recovery actions")
    .option("--scope <scope>", "Codex configuration scope: user or project")
    .option("--config <path>", "target one exact Codex config.toml")
    .option("--codex-profile <profile>", "include a named Codex profile")
    .option(
      "--archive-orphaned-backup <client>",
      "archive a validated orphaned configuration backup without changing the active configuration",
    );
  recover.action(async () => {
    const options = recover.opts() as {
      json?: boolean;
      yes?: boolean;
      scope?: string;
      config?: string;
      codexProfile?: string;
      archiveOrphanedBackup?: string;
    };
    const json = options.json === true;
    try {
      if (options.archiveOrphanedBackup) {
        let adapter: ClientAdapter;
        if (options.archiveOrphanedBackup.toLowerCase() === "codex") {
          const scope = requireCodexScope(options.scope);
          const targets = await resolveCodexTargets({
            ...(scope ? { scope } : {}),
            ...(options.config ? { config: options.config } : {}),
            ...(options.codexProfile
              ? { codexProfile: options.codexProfile }
              : {}),
          });
          const target = await chooseCodexTarget(targets.candidates, json);
          adapter = codexAdapterForTarget(target, targets.adapters);
        } else if (
          options.archiveOrphanedBackup.toLowerCase() === "claude-code"
        ) {
          const adapters = await managementAdapters("claude-code", options);
          if (adapters.length === 0)
            throw new CliError(
              "INVALID_INPUT",
              "No Claude Code configuration scope is available.",
            );
          adapter =
            adapters.length === 1
              ? adapters[0]!
              : await (async () => {
                  const target = await chooseCodexTarget(
                    adapters.map((item) => ({
                      path: item.configPath(),
                      scope: item.configScope(),
                    })),
                    json,
                  );
                  return adapters.find(
                    (item) =>
                      item.configPath() === target.path &&
                      item.configScope() === target.scope,
                  )!;
                })();
        } else {
          if (options.scope || options.config || options.codexProfile)
            throw new CliError(
              "INVALID_INPUT",
              "Codex scope, config, and profile options are supported only for Codex recovery.",
            );
          adapter = getClientAdapter(options.archiveOrphanedBackup);
        }
        if (!options.yes) {
          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            throw new CliError(
              "MISSING_REQUIRED_INPUT",
              "Non-interactive backup archival requires explicit --yes approval.",
            );
          }
          if (
            !(await confirm(
              `Archive only a validated orphaned ${adapter.displayName} backup? The backup will be retained under a unique archive path; the active client configuration will not change. [y/N] `,
              json ? process.stderr : process.stdout,
            ))
          ) {
            const error = new CliError(
              "CANCELLED",
              "Backup archival was cancelled. No changes were made.",
            );
            if (json) printJson(failureResponse("recover", error));
            else console.log(error.message);
            process.exitCode = exitCodeForError(error);
            return;
          }
        }
        const action = await archiveOrphanedConfigBackup(
          adapter,
          new OperationJournal(),
        );
        const reportedAction = {
          ...action,
          detail: safeTerminalText(action.detail, 2048),
        };
        if (json)
          printJson(successResponse("recover", { actions: [reportedAction] }));
        else console.log(`${reportedAction.status}: ${reportedAction.detail}`);
        return;
      }
      const scope =
        options.scope === "local" ? "local" : requireCodexScope(options.scope);
      const scopedAdapters =
        options.scope === "local"
          ? await managementAdapters("claude-code", {
              scope: "local",
            })
          : scope || options.config || options.codexProfile
            ? [
                ...(scope === "project" || scope === "user"
                  ? await managementAdapters("claude-code", { scope })
                  : []),
                ...(await managementAdapters(undefined, {
                  ...(scope ? { scope } : {}),
                  ...(options.config ? { config: options.config } : {}),
                  ...(options.codexProfile
                    ? { codexProfile: options.codexProfile }
                    : {}),
                })),
              ]
            : await getClientAdaptersForContext();
      if (!options.yes) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw new CliError(
            "MISSING_REQUIRED_INPUT",
            "Non-interactive recovery requires explicit --yes approval.",
          );
        }
        if (
          !(await confirm(
            "Reconcile interrupted MCPGet operations? This will not edit client configuration. [y/N] ",
            json ? process.stderr : process.stdout,
          ))
        ) {
          const error = new CliError(
            "CANCELLED",
            "Recovery was cancelled. No changes were made.",
          );
          if (json) printJson(failureResponse("recover", error));
          else console.log(error.message);
          process.exitCode = exitCodeForError(error);
          return;
        }
      }
      const actions = await recoverPendingOperations({
        adapters: scopedAdapters,
        includeUnmatchedOperations:
          !scope && !options.config && !options.codexProfile,
      });
      const blocked = actions.filter((action) => action.status === "blocked");
      if (json) {
        if (blocked.length) {
          printJson(
            failureResponse(
              "recover",
              new CliError(
                "OPERATIONAL_FAILURE",
                "Some recovery operations were retained because their state could not be established safely.",
              ),
              [],
              { actions },
            ),
          );
          process.exitCode = EXIT_CODES.operationalFailure;
        } else {
          printJson(successResponse("recover", { actions }));
        }
      } else {
        for (const action of actions) {
          const target =
            action.client && action.configScope && action.configPath
              ? ` (${action.client} ${action.configScope} scope at ${safeTerminalText(action.configPath, 300)})`
              : "";
          console.log(
            `${action.status}${target}: ${safeTerminalText(action.detail)}`,
          );
        }
        if (blocked.length) process.exitCode = EXIT_CODES.operationalFailure;
        else if (!actions.length)
          console.log("No interrupted operations found.");
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Recovery could not be completed.";
      const cliError =
        error instanceof CliError
          ? error
          : new CliError("OPERATIONAL_FAILURE", message);
      if (json) printJson(failureResponse("recover", cliError));
      else console.error(`Recovery failed: ${safeTerminalText(message)}`);
      process.exitCode = exitCodeForError(cliError);
    }
  });
}

async function diagnose(
  adapter: ClientAdapter,
  json = false,
  allowMissingCodexScope = false,
): Promise<{
  id: string;
  displayName: string;
  ok: boolean;
  message?: string;
  configScope: string;
  configPath: string;
  configPresent?: boolean;
  entryCount: number;
  entries: Array<{
    name: string;
    status: string;
    runtimeExecutable?: string;
  }>;
  codexCliAvailable?: boolean;
}> {
  let configPresent: boolean | undefined;
  try {
    configPresent = await adapter.detect();
    const servers = await readManagementServers(
      adapter,
      allowMissingCodexScope,
    );
    const records = await new InstallationStateStore().all().catch(() => []);
    const entries: Array<{
      name: string;
      status: string;
      runtimeExecutable?: string;
    }> = [];
    if (!json)
      console.log(
        `${adapter.displayName} (${adapter.configScope()} scope): ${configPresent ? `configuration readable (${Object.keys(servers).length} MCP entries)` : "configuration not found (no MCP entries)"} at ${safeTerminalText(adapter.configPath())}`,
      );
    for (const [name, entry] of Object.entries(servers)) {
      const record = records.find(
        (item) =>
          item.client === adapter.id &&
          item.configPath === adapter.configPath() &&
          item.configName === name,
      );
      const status =
        adapter.id === "claude-code" &&
        adapter.configScope() === "project" &&
        (await adapter.projectApprovalStatus?.(name)) === "pending"
          ? "Project-scoped configuration pending Claude Code approval"
          : adapter.id === "claude-code" &&
              adapter.configScope() === "project" &&
              (await adapter.projectApprovalStatus?.(name)) === "disabled"
            ? "Project-scoped configuration disabled by Claude Code"
            : record?.states.connection_verified.status === "completed"
              ? "MCP protocol initialized by MCPGet; client runtime not verified"
              : record?.states.authenticated.status ===
                  "authentication_required"
                ? "authentication required"
                : "configuration present; connection not verified";
      let runtimeExecutable: string | undefined;
      if (entry.command) {
        runtimeExecutable = (await executableExists(entry.command))
          ? "available"
          : "not found";
        if (!json) console.log(`  ${safeTerminalText(name)}: ${status}`);
        if (!json) console.log(`    Runtime executable: ${runtimeExecutable}`);
      } else if (!json) console.log(`  ${safeTerminalText(name)}: ${status}`);
      entries.push({
        name: safeTerminalText(name),
        status,
        ...(runtimeExecutable ? { runtimeExecutable } : {}),
      });
    }
    let codexCliAvailable: boolean | undefined;
    if (adapter.id === "codex") {
      codexCliAvailable = await executableExists("codex");
      if (!json)
        console.log(
          `Codex CLI for optional OAuth login: ${codexCliAvailable ? "available" : "not found"}`,
        );
    }
    const missingRuntime = entries.some(
      (entry) => entry.runtimeExecutable === "not found",
    );
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      ok: !missingRuntime,
      ...(missingRuntime
        ? {
            message: `${adapter.displayName}: one or more configured runtime executables are not available.`,
          }
        : {}),
      configPath: adapter.configPath(),
      configScope: adapter.configScope(),
      configPresent,
      entryCount: Object.keys(servers).length,
      entries,
      ...(codexCliAvailable !== undefined ? { codexCliAvailable } : {}),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "configuration unavailable";
    if (!json)
      console.log(`${adapter.displayName}: ${safeTerminalText(message)}`);
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      ok: false,
      message: safeTerminalText(message),
      configPath: adapter.configPath(),
      configScope: adapter.configScope(),
      ...(configPresent !== undefined ? { configPresent } : {}),
      entryCount: 0,
      entries: [],
    };
  }
}

async function readManagementServers(
  adapter: ClientAdapter,
  allowMissing = false,
): Promise<Record<string, ServerConfiguration>> {
  try {
    return await adapter.read();
  } catch (error) {
    if (
      adapter.id === "codex" &&
      allowMissing &&
      error instanceof Error &&
      /(?:user|project)-scope configuration is missing/i.test(error.message)
    )
      return {};
    throw error;
  }
}

async function codexScopeDisclosure(profile?: string): Promise<{
  inspected: Array<{ scope: string; configPath: string }>;
  notInspected: string[];
}> {
  const resolved = await getCodexAdaptersForContext(profile);
  const { context } = resolved;
  const notInspected =
    context.projectStatus === "untrusted"
      ? [
          `Project configuration at ${context.projectTargetPath ?? context.projectRoot ?? "the current project"} was not inspected because project trust is not established.`,
        ]
      : context.projectStatus === "not_found"
        ? [
            "No Codex project root was identified from the current directory; no project configuration was inspected.",
          ]
        : context.projectConfigPaths.length === 0
          ? [
              `No existing trusted project configuration was found; ${context.projectTargetPath ?? "the project config.toml"} is available as a target but was not read.`,
            ]
          : [];
  return {
    inspected: resolved.allAdapters.map((adapter) => ({
      scope: adapter.configScope(),
      configPath: adapter.configPath(),
    })),
    notInspected,
  };
}

async function managementAdapters(
  clientId: string | undefined,
  options: {
    scope?: string;
    config?: string;
    codexProfile?: string;
  },
): Promise<ClientAdapter[]> {
  const claudeCodeOptions = clientId?.toLowerCase() === "claude-code";
  const copilotOptions =
    clientId?.toLowerCase() === "copilot-vscode" ||
    clientId?.toLowerCase() === "copilot-cli";
  if (copilotOptions) {
    if (options.codexProfile)
      throw new CliError(
        "INVALID_INPUT",
        "Codex profile options are not supported for Copilot.",
      );
    const requestedScope =
      options.scope === undefined
        ? "user"
        : options.scope === "user" || options.scope === "project"
          ? options.scope
          : "";
    if (!requestedScope)
      throw new CliError(
        "INVALID_INPUT",
        "Unsupported Copilot scope. Choose user or project.",
      );
    const context = await resolveCopilotScopeContext();
    let targets = context.targets.filter(
      (target) =>
        target.id === clientId!.toLowerCase() &&
        target.scope === requestedScope,
    );
    if (options.config)
      targets = targets.filter(
        (target) =>
          path.resolve(target.configPath) === path.resolve(options.config!),
      );
    if (requestedScope === "project" && !targets.length)
      throw new CliError(
        "INVALID_INPUT",
        "No Copilot project MCP configuration target is available. Use --config for an exact project file.",
      );
    if (requestedScope === "project" && targets.length > 1)
      targets = [
        targets.find(
          (target) =>
            target.configPath.endsWith(".mcp.json") &&
            !target.configPath.includes(".github"),
        ) ?? targets[0]!,
      ];
    return targets.map(
      (target) =>
        new JsonClientAdapter(
          target.id,
          target.id === "copilot-vscode"
            ? "GitHub Copilot in VS Code"
            : "GitHub Copilot CLI",
          target.configPath,
          undefined,
          target.scope as "user" | "project",
          target.format,
        ),
    );
  }
  const scope = claudeCodeOptions
    ? options.scope === undefined
      ? undefined
      : options.scope === "user" ||
          options.scope === "project" ||
          options.scope === "local"
        ? options.scope
        : (() => {
            throw new CliError(
              "INVALID_INPUT",
              "Unsupported Claude Code scope. Choose user, project, or local.",
            );
          })()
    : requireCodexScope(options.scope);
  const codexOptions = Boolean(scope || options.config || options.codexProfile);
  if (claudeCodeOptions) {
    if (options.config || options.codexProfile)
      throw new CliError(
        "INVALID_INPUT",
        "Codex config and profile options are not supported for Claude Code.",
      );
    const context = await resolveClaudeCodeScopeContext();
    const adapters = context.targets
      .filter((target) => target.scope !== "project" || target.trusted)
      .map(
        (target) =>
          new ClaudeCodeAdapter(
            context.claudeJsonPath,
            target.scope,
            target.projectRoot,
          ),
      )
      .filter((adapter) => !scope || adapter.configScope() === scope);
    if (scope === "project" && !adapters.length)
      throw new CliError(
        "INVALID_INPUT",
        "Claude Code project trust is not established. Trust the project in Claude Code before accessing project-scoped MCP configuration.",
      );
    return adapters;
  }
  if (clientId && clientId.toLowerCase() !== "codex") {
    if (codexOptions)
      throw new CliError(
        "INVALID_INPUT",
        "Codex scope, config, and profile options are supported only for Codex.",
      );
    return [getClientAdapter(clientId)];
  }
  if (!clientId && !codexOptions) return getClientAdaptersForContext();

  const resolved = await getCodexAdaptersForContext(options.codexProfile);
  if (scope === "project") await resolveCodexTargets({ scope });
  if (options.config)
    await resolveCodexTargets({
      config: options.config,
      ...(options.codexProfile ? { codexProfile: options.codexProfile } : {}),
    });

  const adapters = resolved.allAdapters.filter(
    (adapter) =>
      (!scope || adapter.configScope() === scope) &&
      (!options.config ||
        path.resolve(adapter.configPath()) === path.resolve(options.config)),
  );
  if (options.config && !adapters.length)
    throw new CliError(
      "INVALID_INPUT",
      `No readable Codex adapter matches configuration path ${safeTerminalText(options.config, 500)}.`,
    );
  return adapters;
}

async function executableExists(command: string): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  const { delimiter, isAbsolute, join } = await import("node:path");
  const { platform } = await import("node:os");
  const extensions =
    platform() === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  const candidates = isAbsolute(command)
    ? [
        command,
        ...extensions.map(
          (extension) => `${command}${extension.toLowerCase()}`,
        ),
      ]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .flatMap((directory) =>
          extensions.map((extension) =>
            join(directory, `${command}${extension.toLowerCase()}`),
          ),
        );
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return true;
    } catch {
      /* continue PATH search */
    }
  }
  return false;
}

async function confirm(
  question: string,
  output: Writable = process.stdout,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Interactive confirmation is required; no changes were made.",
    );
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}
