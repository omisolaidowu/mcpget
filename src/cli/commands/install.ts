import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import type { Writable } from "node:stream";
import path from "node:path";
import {
  discoverByServiceUrl,
  type CandidateSource,
  type DiscoveryMetadata,
} from "../../discovery/search-service.js";
import {
  OfficialRegistryAdapter,
  RegistryError,
} from "../../discovery/registry/official-registry-adapter.js";
import { getClientAdapter } from "../../installers/adapters.js";
import {
  codexAdapterForTarget,
  chooseCodexTarget,
  requireCodexScope,
  resolveCodexTargets,
} from "../codex-target.js";
import {
  detectExistingServerMatches,
  type ExistingServerMatch,
} from "../../installers/existing-server-detection.js";
import { createInstallPlan } from "../../installers/plan-installer.js";
import { ClaudeCodeAdapter } from "../../installers/claude-code-adapter.js";
import { resolveClaudeCodeScopeContext } from "../../installers/claude-code-scopes.js";
import { resolveCopilotScopeContext } from "../../installers/copilot-scopes.js";
import { JsonClientAdapter } from "../../installers/json-client-adapter.js";
import { InstallationStateStore } from "../../installers/state-store.js";
import type { ServerCandidate } from "../../models/server-candidate.js";
import type { CandidateEvaluation } from "../../models/candidate-evaluation.js";
import {
  createInstallationRecord,
  type InstallationRecord,
  type InstallationStep,
} from "../../models/installation.js";
import {
  verifyHttpMcp,
  verifyStdioMcp,
  type McpVerificationResult,
} from "../../verification/mcp-connection.js";
import { safeTerminalText } from "../output.js";
import {
  findManagedNpm,
  installManagedNpm,
  managedInstallPath,
  releaseManagedAssociation,
  updateManagedMetadata,
} from "../../installers/managed-npm.js";
import { withFileLock } from "../../installers/file-lock.js";
import { OperationJournal } from "../../installers/operation-journal.js";
import {
  ensureConfigBackupLifecycle,
  validateBackupClientConfiguration,
} from "../../installers/config-backup-lifecycle.js";
import { recoverPendingOperations } from "../../installers/recovery.js";
import {
  parsePublicHttpsEndpoint,
  RemoteEndpointSecurityError,
  validatePublicHttpsEndpoint,
} from "../../security/remote-endpoint.js";
import {
  collectRequiredCredentials,
  classifyCredentialKind,
  collectInheritedRequiredCredentials,
  CredentialPromptCancelled,
  createTerminalCredentialPrompt,
  nonInteractiveCredentialPrompt,
} from "../credentials.js";
import type { RegistryInputRequirement } from "../../models/server-candidate.js";
import type {
  ClientAdapter,
  ExistingServerRegistration,
  ServerConfiguration,
} from "../../installers/types.js";
import { normalizeServerRegistration } from "../../installers/types.js";
import {
  CliError,
  EXIT_CODES,
  exitCodeForError,
  failureResponse,
  PARTIAL_DISCOVERY_WARNING,
  printJson,
  successResponse,
} from "../output.js";

export interface CandidateSelectionPresentation {
  heading: string[];
  labels: string[];
  details: Array<string | undefined>;
  footer: string[];
}

type CandidateSelector = (
  question: string,
  choices: string[],
  presentation?: CandidateSelectionPresentation,
) => Promise<string>;

export function registerInstallCommand(
  program: Command,
  source?: CandidateSource,
  candidateSelector: CandidateSelector = selectOne,
): void {
  const installCommand = program
    .command("install <server> <client>")
    .description("Install or register an MCP server for one AI client")
    .option(
      "--ephemeral",
      "Use an ephemeral runtime instead of a persistent managed installation",
    )
    .option("--json", "print the operation result as JSON")
    .option("--yes", "explicitly approve the proposed installation")
    .option(
      "--allow-lifecycle-scripts",
      "explicitly allow package installation scripts for a managed or ephemeral npm package",
    )
    .option("--candidate <registry-id>", "select an exact Registry candidate")
    .option("--scope <scope>", "Codex configuration scope: user or project")
    .option("--config <path>", "target one exact Codex config.toml")
    .option(
      "--codex-profile <profile>",
      "include and target a named Codex profile",
    )
    .option(
      "--source <source>",
      "select an exact source: remote or registry-type:identifier",
    )
    .action(async (server: string, clientId: string) => {
      const stateStore = new InstallationStateStore();
      const journal = new OperationJournal();
      let operationId: string | undefined;
      let record: InstallationRecord | undefined;
      let documentedRequirements: RegistryInputRequirement[] = [];
      let discoveryMetadata: DiscoveryMetadata | undefined;
      let credentialProvision:
        | {
            status: "configured" | "missing" | "conflict" | "none";
            suppliedNames: string[];
            missingNames: string[];
            conflictNames: string[];
            replacedNames: string[];
            kinds: Record<
              string,
              "secret" | "directory_path" | "configuration"
            >;
          }
        | undefined;
      const discoveryWarnings = (): string[] =>
        discoveryMetadata?.status === "partial"
          ? [PARTIAL_DISCOVERY_WARNING]
          : [];
      let json = false;
      let lifecycleScriptsEnabled = false;
      let phase:
        | "resolve"
        | "installation"
        | "verification"
        | "configuration"
        | "complete" = "resolve";
      try {
        const options = installCommand.opts() as {
          ephemeral?: boolean;
          json?: boolean;
          yes?: boolean;
          allowLifecycleScripts?: boolean;
          candidate?: string;
          source?: string;
          scope?: string;
          config?: string;
          codexProfile?: string;
        };
        json = options.json === true;
        const isClaudeCode = clientId.toLowerCase() === "claude-code";
        const isCopilot =
          clientId.toLowerCase() === "copilot-vscode" ||
          clientId.toLowerCase() === "copilot-cli";
        const scope =
          isClaudeCode || isCopilot
            ? undefined
            : requireCodexScope(options.scope);
        let adapter: ReturnType<typeof getClientAdapter>;
        let codexAdapters: ClientAdapter[] = [];
        let claudeCodeAdapters: ClientAdapter[] = [];
        let claudeCodeProjectRoot: string | undefined;
        let copilotAdapters: ClientAdapter[] = [];
        let codexProjectStatus:
          "available" | "untrusted" | "not_found" | undefined;
        if (clientId.toLowerCase() === "codex") {
          const targets = await resolveCodexTargets({
            ...(scope ? { scope } : {}),
            ...(options.config ? { config: options.config } : {}),
            ...(options.codexProfile
              ? { codexProfile: options.codexProfile }
              : {}),
          });
          const selectedTarget = await chooseCodexTarget(
            targets.candidates,
            json,
          );
          adapter = codexAdapterForTarget(selectedTarget, targets.adapters);
          codexAdapters = targets.adapters;
          codexProjectStatus = targets.context.projectStatus;
        } else if (isClaudeCode) {
          if (options.config || options.codexProfile)
            throw new CliError(
              "INVALID_INPUT",
              "Codex config and profile options are not supported by Claude Code.",
            );
          const requestedScope =
            options.scope === undefined
              ? "local"
              : options.scope === "user" ||
                  options.scope === "project" ||
                  options.scope === "local"
                ? options.scope
                : "";
          if (!requestedScope)
            throw new CliError(
              "INVALID_INPUT",
              "Unsupported Claude Code scope. Choose user, project, or local.",
            );
          const context = await resolveClaudeCodeScopeContext();
          claudeCodeAdapters = context.targets
            .filter((target) => target.scope !== "project" || target.trusted)
            .map(
              (target) =>
                new ClaudeCodeAdapter(
                  context.claudeJsonPath,
                  target.scope,
                  target.projectRoot,
                ),
            );
          const selected = claudeCodeAdapters.find(
            (item) => item.configScope() === requestedScope,
          );
          if (!selected) {
            if (requestedScope === "project")
              throw new CliError(
                "INVALID_INPUT",
                "Claude Code project trust is not established. Trust the project in Claude Code before installing project-scoped MCP configuration.",
              );
            throw new CliError(
              "INVALID_INPUT",
              `No Claude Code ${requestedScope} scope is available from the current project context.`,
            );
          }
          claudeCodeProjectRoot = context.targets.find(
            (target) =>
              target.scope === requestedScope &&
              target.configPath === selected.configPath(),
          )?.projectRoot;
          adapter = selected;
        } else if (isCopilot) {
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
          const baseTargets = context.targets.filter(
            (target) =>
              target.id === clientId.toLowerCase() &&
              (!requestedScope || target.scope === requestedScope),
          );
          const scopedTargets =
            !options.config && requestedScope === "project"
              ? baseTargets.length > 1
                ? [
                    baseTargets.find(
                      (target) =>
                        target.configPath.endsWith(".mcp.json") &&
                        !target.configPath.includes(".github"),
                    ) ?? baseTargets[0]!,
                  ]
                : baseTargets
              : baseTargets;
          copilotAdapters = scopedTargets.map(
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
          if (options.config)
            copilotAdapters = copilotAdapters.filter(
              (item) =>
                path.resolve(item.configPath()) ===
                path.resolve(options.config!),
            );
          if (copilotAdapters.length !== 1)
            throw new CliError(
              "INVALID_INPUT",
              requestedScope === "project"
                ? "No Copilot project MCP configuration target is available for the current project. Use --config for an exact .mcp.json or supported project file."
                : "No Copilot user MCP configuration target is available.",
            );
          adapter = copilotAdapters[0]!;
        } else {
          if (scope || options.config || options.codexProfile)
            throw new CliError(
              "INVALID_INPUT",
              "Codex scope, config, and profile options are supported only when installing to Codex.",
            );
          adapter = getClientAdapter(clientId);
        }
        const candidate = await resolve(
          server,
          options.candidate,
          source,
          candidateSelector,
          (metadata) => {
            discoveryMetadata = metadata;
          },
          !json,
        );
        const sourceOptions = [
          ...(candidate.operational.remoteEndpoints.some((endpoint) =>
            endpoint.startsWith("https://"),
          )
            ? ["remote"]
            : []),
          ...candidate.operational.packages
            .filter((item) => item.identifier && item.registryType)
            .map(
              (item) =>
                `${item.registryType!.toLowerCase()}:${item.identifier}`,
            ),
        ];
        let selectedSource: string | undefined;
        if (options.source) {
          if (!sourceOptions.includes(options.source)) {
            throw new CliError(
              "UNSUPPORTED_OPERATION",
              `Unsupported source "${options.source}". Available sources: ${sourceOptions.join(", ")}.`,
            );
          }
          selectedSource = options.source;
        } else if (sourceOptions.length > 1) {
          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            throw new CliError(
              "INVALID_INPUT",
              `Multiple installation sources are available. Retry with --source using one of: ${sourceOptions.join(", ")}.`,
            );
          }
          selectedSource = await selectOne(
            "Choose installation source:",
            sourceOptions,
          );
        }
        const plan = createInstallPlan(
          candidate,
          undefined,
          selectedSource,
          options.ephemeral === true,
          options.allowLifecycleScripts === true,
        );
        if (adapter.id === "claude" && plan.entry.url)
          throw new Error(
            "Claude remote MCP connectors are managed in Claude settings; MCPGet will not edit an undocumented remote configuration. Add the endpoint in Claude’s custom connectors UI.",
          );
        record = createInstallationRecord({
          id: candidate.registryIdentifier,
          serverIdentifier: candidate.registryIdentifier,
          displayName: candidate.title ?? candidate.name,
          client: adapter.id,
          source: plan.method,
          strategy: plan.strategy,
          configName: plan.entry.name,
          configPath: adapter.configPath(),
          configScope: adapter.configScope(),
          ...(claudeCodeProjectRoot
            ? { projectRoot: claudeCodeProjectRoot }
            : {}),
        });
        if (plan.entry.url) {
          record.remoteEndpoint = plan.entry.url;
          record.remoteEndpointTrust = "pending";
        }
        if (plan.strategy === "managed" && plan.packageIdentifier) {
          record.packageIdentifier = plan.packageIdentifier;
          record.installationPath = managedInstallPath(
            plan.packageIdentifier,
            plan.packageVersion,
          );
        }
        const detectionAdapters =
          adapter.id === "codex"
            ? [
                ...new Map(
                  [...codexAdapters, adapter].map((item) => [
                    item.configPath(),
                    item,
                  ]),
                ).values(),
              ]
            : adapter.id === "copilot-vscode" || adapter.id === "copilot-cli"
              ? [
                  ...new Map(
                    [
                      getClientAdapter("copilot-vscode"),
                      getClientAdapter("copilot-cli"),
                      ...copilotAdapters,
                    ].map((item) => [
                      `${item.configScope()}\0${item.configPath()}`,
                      item,
                    ]),
                  ).values(),
                ]
              : adapter.id === "claude-code"
                ? [
                    ...new Map(
                      [...claudeCodeAdapters, adapter].map((item) => [
                        `${item.configScope()}\0${item.configPath()}`,
                        item,
                      ]),
                    ).values(),
                  ]
                : [adapter];
        const initialMatches = await findExistingMatches(
          candidate.registryIdentifier,
          plan.entry,
          plan.packageIdentifier,
          detectionAdapters,
          stateStore,
        );
        if (
          initialMatches.some(
            (match) => match.classification === "confirmed_duplicate",
          )
        ) {
          const confirmed = initialMatches.filter(
            (match) => match.classification === "confirmed_duplicate",
          );
          if (json)
            printJson(
              successResponse(
                "install",
                {
                  alreadyConfigured: true,
                  existingRegistrations: existingMatchData(confirmed),
                  target: {
                    scope: adapter.configScope(),
                    configPath: adapter.configPath(),
                  },
                  ...(discoveryMetadata?.status === "partial"
                    ? { discovery: discoveryMetadata }
                    : {}),
                },
                discoveryWarnings(),
              ),
            );
          else {
            console.log(
              [
                ...discoveryWarnings(),
                `Already configured; no package or configuration changes were made.\n${formatExistingMatches(confirmed)}`,
              ].join("\n"),
            );
          }
          return;
        }
        const targetConflicts = initialMatches.filter(
          (match) =>
            match.classification === "name_conflict" &&
            match.configPath === adapter.configPath(),
        );
        if (targetConflicts.length)
          throw new CliError(
            "INVALID_INPUT",
            `The target configuration already uses the registration name ${plan.entry.name} for a different server. Select another scope/config or resolve the existing entry first.`,
          );
        const possibleMatches = initialMatches.filter(
          (match) => match.classification === "possible_duplicate",
        );
        if (possibleMatches.length) {
          const details = formatExistingMatches(possibleMatches);
          if (!options.yes) {
            if (!process.stdin.isTTY || !process.stdout.isTTY)
              throw new CliError(
                "MISSING_REQUIRED_INPUT",
                `Possible existing registrations were found. Review them and retry with --yes to explicitly proceed.\n${details}`,
              );
            if (
              !(await confirm(
                `Possible existing registrations were found:\n${details}\nProceed with another registration? [y/N] `,
                json ? process.stderr : process.stdout,
              ))
            ) {
              throw new CliError(
                "CANCELLED",
                "Installation was cancelled after possible existing registrations were found.",
              );
            }
          }
        }
        const current = await preflightClientConfiguration(adapter, journal);
        const priorRecord = await stateStore.get(
          candidate.registryIdentifier,
          adapter.id,
          adapter.configPath(),
        );
        let confirmationVersion = plan.packageVersion;
        if (plan.strategy === "managed" && plan.packageIdentifier) {
          const existingManaged = await findManagedNpm(
            plan.packageIdentifier,
            plan.packageVersion,
          );
          if (existingManaged) {
            plan.entry.command = existingManaged.command;
            plan.entry.args = existingManaged.args;
            confirmationVersion ??= existingManaged.installedVersion;
          }
        }
        const persistedMatchBeforeInstall = await adapter.verify(plan.entry);
        const managedPriorEntry =
          priorRecord?.configName === plan.entry.name &&
          priorRecord.configPath === adapter.configPath() &&
          (priorRecord.configScope ?? "user") === adapter.configScope();
        if (
          current[plan.entry.name] &&
          !persistedMatchBeforeInstall.verified &&
          !managedPriorEntry
        ) {
          throw new Error(
            `A different server named ${plan.entry.name} is already configured for ${adapter.displayName}. Remove or rename it first.`,
          );
        }
        const confirmationDetails = [
          "MCPGet installation confirmation",
          `Source: ${safeTerminalText(candidate.sourceRegistry)} · ${safeTerminalText(candidate.sourceRecordUrl, 180)}`,
          `Target: ${adapter.displayName}`,
          `Configuration scope: ${adapter.configScope()}`,
          `Configuration: ${safeTerminalText(adapter.configPath())}`,
          ...(codexProjectStatus === "untrusted"
            ? [
                "Project scope was not inspected because the current Codex project is untrusted; no project config will be created or changed.",
              ]
            : []),
        ];
        if (plan.strategy === "managed" && plan.packageIdentifier) {
          confirmationDetails.push(
            `Package: ${safeTerminalText(plan.packageIdentifier)}`,
            `Version: ${confirmationVersion ? safeTerminalText(confirmationVersion) : "latest; resolved version will be recorded"}`,
            `Installation location: ${safeTerminalText(record.installationPath!)}`,
            `Package installation scripts: ${options.allowLifecycleScripts ? "enabled by explicit --allow-lifecycle-scripts approval" : "disabled by default"}.`,
          );
        } else if (plan.strategy === "ephemeral" && plan.packageIdentifier) {
          confirmationDetails.push(
            `Package: ${safeTerminalText(plan.packageIdentifier)}`,
            `Version: ${plan.packageVersion ? safeTerminalText(plan.packageVersion) : "latest"}`,
            "Installation location: downloaded at client launch",
            `Package installation scripts: ${options.allowLifecycleScripts ? "enabled by explicit --allow-lifecycle-scripts approval" : "disabled by default"}.`,
          );
        }
        if (plan.entry.url) {
          confirmationDetails.push(
            `Remote endpoint: ${safeTerminalText(plan.entry.url, 2048)}`,
            "Destination policy: HTTPS with globally routable addresses only; local/private destinations are blocked.",
          );
          try {
            await validatePublicHttpsEndpoint(plan.entry.url);
            record.remoteEndpointTrust = "public_https";
          } catch (error) {
            record.remoteEndpointTrust = "rejected";
            throw error;
          }
        }
        if (plan.strategy === "ephemeral" && !plan.packageIdentifier)
          confirmationDetails.push(
            `Explicit ephemeral execution requested: ${plan.entry.command} ${(plan.entry.args ?? []).join(" ")}`,
          );
        if (!json) console.log(confirmationDetails.join("\n"));
        if (!options.yes) {
          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            throw new CliError(
              "MISSING_REQUIRED_INPUT",
              "Non-interactive installation requires explicit --yes approval.",
            );
          }
          if (
            !(await confirm(
              "Continue? [y/N] ",
              json ? process.stderr : process.stdout,
            ))
          ) {
            if (!json) console.log("Cancelled; no changes made.");
            else
              printJson(
                failureResponse(
                  "install",
                  new CliError(
                    "CANCELLED",
                    "Installation was cancelled. No changes were made.",
                  ),
                  discoveryWarnings(),
                ),
              );
            process.exitCode = EXIT_CODES.cancelled;
            return;
          }
        }
        lifecycleScriptsEnabled = options.allowLifecycleScripts === true;
        if (
          lifecycleScriptsEnabled &&
          plan.strategy !== "managed" &&
          !(plan.strategy === "ephemeral" && plan.packageType === "npm")
        ) {
          throw new CliError(
            "UNSUPPORTED_OPERATION",
            "--allow-lifecycle-scripts is supported only for npm installations.",
          );
        }
        record.lifecycleScriptsEnabled = lifecycleScriptsEnabled;
        phase = "installation";
        await ensureClientConfigurationLifecycle(adapter, journal);
        const operation = await journal.begin({
          kind: "install",
          client: adapter.id,
          configPath: adapter.configPath(),
          configScope: adapter.configScope(),
          ...(record.projectRoot ? { projectRoot: record.projectRoot } : {}),
          configName: record.configName,
          serverIdentifier: record.serverIdentifier,
          ...(record.installationPath
            ? { installationPath: record.installationPath }
            : {}),
          ...(record.packageIdentifier
            ? { packageIdentifier: record.packageIdentifier }
            : {}),
        });
        operationId = operation.id;
        record.states.install_confirmed = completed(
          "User approved the proposed server source and target client.",
        );
        await stateStore.put(record);
        if (plan.strategy === "managed" && plan.packageIdentifier) {
          const installed = await installManagedNpm(
            plan.packageIdentifier,
            plan.packageVersion,
            180_000,
            { allowLifecycleScripts: lifecycleScriptsEnabled },
          );
          record.installationPath = installed.directory;
          record.packageIdentifier = installed.packageIdentifier;
          record.installedVersion = installed.installedVersion;
          lifecycleScriptsEnabled = installed.lifecycleScriptsEnabled;
          record.lifecycleScriptsEnabled = lifecycleScriptsEnabled;
          documentedRequirements = installed.documentedRequirements ?? [];
          record.states.installed = completed(
            `${installed.reused ? "Reused" : "Installed"} ${installed.packageIdentifier}@${installed.installedVersion} in MCPGet's managed directory.`,
          );
          await journal.advance(operation.id, "package_installed");
          plan.entry.command = installed.command;
          plan.entry.args = installed.args;
          await updateManagedMetadata(installed, {
            serverIdentifier: record.serverIdentifier,
            serverName: record.displayName,
            client: adapter.id,
            configurationEntry: record.configName,
            verificationStatus: "configuration_pending",
          });
          await journal.advance(operation.id, "association_reserved");
          await stateStore.put(record);
        }
        const requiredInputs = mergeRequiredInputs(
          candidate.operational.configurationInputs,
          documentedRequirements,
        );
        const supportsEnvironment =
          plan.strategy !== "remote" && !plan.entry.url;
        const existingEnv = supportsEnvironment
          ? (current[plan.entry.name]?.env ?? {})
          : {};
        if (supportsEnvironment) plan.entry.env = { ...existingEnv };
        const credentialInputs = requiredInputs.filter(
          (input) => !isOAuthInput(input),
        );
        if (credentialInputs.length && supportsEnvironment && !json) {
          console.log(
            `\nAuthentication configuration required:\n${credentialInputs.map((input) => `  ${safeTerminalText(input.name, 80)}`).join("\n")}`,
          );
          console.log(
            "The client configuration may store environment-variable values in plaintext. MCPGet will not store them in its installation metadata.",
          );
        }
        const nonInteractive = !process.stdin.isTTY || !process.stdout.isTTY;
        const effectiveExistingEnv = { ...existingEnv };
        let inheritedCredentialNames: string[] = [];
        let inheritedConflictNames: string[] = [];
        const inheritedReplacedNames: string[] = [];
        const credentialKinds: Record<
          string,
          "secret" | "directory_path" | "configuration"
        > = {};
        for (const input of credentialInputs) {
          credentialKinds[input.name] = classifyCredentialKind(input);
        }
        if (nonInteractive && json && supportsEnvironment) {
          const inherited = collectInheritedRequiredCredentials(
            credentialInputs,
            process.env,
            existingEnv,
          );
          inheritedCredentialNames = inherited.suppliedNames;
          inheritedConflictNames = inherited.conflictNames;
          for (const name of inherited.suppliedNames) {
            effectiveExistingEnv[name] = inherited.values[name]!;
            if (inherited.conflictNames.includes(name))
              inheritedReplacedNames.push(name);
          }
          credentialProvision = {
            status:
              inheritedConflictNames.length > 0
                ? "conflict"
                : inheritedCredentialNames.length > 0
                  ? "configured"
                  : "missing",
            suppliedNames: inheritedCredentialNames,
            missingNames: inherited.missingNames,
            conflictNames: inheritedConflictNames,
            replacedNames: inheritedReplacedNames,
            kinds: credentialKinds,
          };
        } else {
          credentialProvision = {
            status: credentialInputs.length > 0 ? "missing" : "none",
            suppliedNames: [],
            missingNames: [],
            conflictNames: [],
            replacedNames: [],
            kinds: credentialKinds,
          };
        }
        if (nonInteractive) {
          const missingNames = credentialInputs
            .map((input) => input.name)
            .filter(
              (name) =>
                !Object.prototype.hasOwnProperty.call(
                  effectiveExistingEnv,
                  name,
                ),
            );
          if (missingNames.length) {
            credentialProvision = {
              ...credentialProvision!,
              status: "missing",
              missingNames,
            };
            record.states.setup_required = {
              status: "setup_required",
              detail: `Missing required environment variables: ${missingNames.join(", ")}.`,
              at: new Date().toISOString(),
            };
            record.states.authenticated = {
              status: "not_verified",
              detail: "Authentication was not independently verified.",
              at: new Date().toISOString(),
            };
            throw new CliError(
              "MISSING_REQUIRED_INPUT",
              `Missing required credential${missingNames.length === 1 ? "" : "s"}: ${missingNames.join(", ")}. Existing interactive terminal input or an existing client configuration is required.`,
            );
          }
        }
        const credentials = await collectRequiredCredentials(
          requiredInputs,
          effectiveExistingEnv,
          supportsEnvironment,
          nonInteractive
            ? nonInteractiveCredentialPrompt
            : json
              ? createTerminalCredentialPrompt(process.stderr)
              : undefined,
        );
        const requiredEnvironmentNames = requiredInputs
          .filter((input) => !isOAuthInput(input))
          .map((input) => input.name);
        const suppliedRequiredNames = requiredEnvironmentNames.filter((name) =>
          Object.prototype.hasOwnProperty.call(credentials.values, name),
        );
        credentialProvision = {
          ...credentialProvision!,
          status:
            credentials.skipped.length > 0
              ? "missing"
              : credentialProvision!.conflictNames.length > 0 &&
                  credentialProvision!.replacedNames.length <
                    credentialProvision!.conflictNames.length
                ? "conflict"
                : suppliedRequiredNames.length > 0
                  ? "configured"
                  : "none",
          suppliedNames: suppliedRequiredNames,
          missingNames: credentials.skipped,
          kinds: credentialKinds,
        };
        const credentialSetupComplete =
          requiredEnvironmentNames.length > 0 &&
          suppliedRequiredNames.length === requiredEnvironmentNames.length;
        if (supportsEnvironment) {
          plan.entry.env ??= {};
          for (const name of credentials.skipped) delete plan.entry.env[name];
          Object.assign(plan.entry.env, credentials.values);
          if (
            Object.keys(plan.entry.env).length === 0 &&
            requiredInputs.length === 0 &&
            Object.keys(existingEnv).length === 0
          )
            delete plan.entry.env;
        }
        if (credentials.skipped.length && !json) {
          console.log(
            `Setup remains incomplete; no value was provided for: ${credentials.skipped.map((name) => safeTerminalText(name, 80)).join(", ")}.`,
          );
        }
        if (credentials.unsupported.length && !json) {
          console.log(
            `Setup remains incomplete; ${adapter.displayName} cannot pass required environment values to this remote endpoint: ${credentials.unsupported.map((name) => safeTerminalText(name, 80)).join(", ")}.`,
          );
        }
        if (credentials.oauth.length && !json) {
          console.log(
            `OAuth setup required (${credentials.oauth.map((name) => safeTerminalText(name, 80)).join(", ")}); complete the MCP client/server's documented sign-in flow. MCPGet does not collect OAuth tokens.`,
          );
        }
        let verification: McpVerificationResult;
        phase = "verification";
        const setupPending =
          credentials.skipped.length > 0 ||
          credentials.unsupported.length > 0 ||
          credentials.oauth.length > 0;
        if (credentials.skipped.length || credentials.unsupported.length) {
          verification = {
            status: "initialization_failed",
            detail:
              "Startup and connection verification were deferred because required environment setup is incomplete.",
            startupVerified: false,
          };
          record.states.startup_verified = plan.entry.url
            ? {
                status: "not_applicable",
                detail: "Remote endpoint; no local server process was started.",
              }
            : {
                status: "not_verified",
                detail: verification.detail,
                at: new Date().toISOString(),
              };
          record.states.connection_verified = {
            status: "not_verified",
            detail: verification.detail,
            at: new Date().toISOString(),
          };
        } else if (plan.entry.url)
          verification = await verifyHttpMcp(plan.entry.url);
        else
          verification = await verifyStdioMcp(
            plan.entry.command!,
            plan.entry.args!,
            plan.entry.env ? { env: plan.entry.env } : {},
          );
        if (setupPending) {
          record.states.setup_required = {
            status: "setup_required",
            detail: [
              ...(credentials.skipped.length
                ? [
                    `Missing required environment variables: ${credentials.skipped.join(", ")}.`,
                  ]
                : []),
              ...(credentials.unsupported.length
                ? [
                    `Unsupported remote environment configuration: ${credentials.unsupported.join(", ")}.`,
                  ]
                : []),
              ...(credentials.oauth.length
                ? [
                    "OAuth setup is required through the client/server workflow.",
                  ]
                : []),
            ].join(" "),
            at: new Date().toISOString(),
          };
        } else if (
          verification.status === "authentication_required" &&
          suppliedRequiredNames.length === 0
        ) {
          record.states.setup_required = {
            status: "setup_required",
            detail:
              "Authentication is required, but MCPGet could not identify a specific credential or OAuth flow.",
            at: new Date().toISOString(),
          };
        } else if (credentialSetupComplete) {
          record.states.setup_required = {
            status: "not_verified",
            detail:
              "Required environment values were collected; client configuration verification is pending.",
            at: new Date().toISOString(),
          };
        } else {
          record.states.setup_required = {
            status: "not_applicable",
            detail:
              "No documented authentication or credential setup was identified.",
            at: new Date().toISOString(),
          };
        }
        if (plan.entry.url)
          record.states.startup_verified = {
            status: "not_applicable",
            detail: "Remote endpoint; no local server process was started.",
          };
        if (credentials.skipped.length || credentials.unsupported.length) {
          record.states.authenticated = {
            status: "not_verified",
            detail: "Authentication was not independently verified.",
            at: new Date().toISOString(),
          };
        } else if (verification.status === "authentication_required") {
          record.states.startup_verified = plan.entry.url
            ? {
                status: "not_applicable",
                detail: "Remote endpoint; no local server process was started.",
              }
            : verification.startupVerified
              ? completed(
                  "The server process started; authentication is required before MCP initialization.",
                )
              : {
                  status: "failed",
                  detail: verification.detail,
                  at: new Date().toISOString(),
                };
          record.states.authenticated = {
            status: "authentication_required",
            detail: verification.detail,
            at: new Date().toISOString(),
          };
          record.states.connection_verified = {
            status: "authentication_required",
            detail: "MCP initialization requires authentication.",
            at: new Date().toISOString(),
          };
        } else if (verification.status === "connection_verified") {
          record.states.startup_verified = plan.entry.url
            ? {
                status: "not_applicable",
                detail: "Remote endpoint; no local server process was started.",
              }
            : verification.startupVerified
              ? completed(
                  "Server process started and responded to the bounded verification check.",
                )
              : {
                  status: "failed",
                  detail: "The server process did not start.",
                  at: new Date().toISOString(),
                };
          record.states.connection_verified = completed(
            `${verification.detail}${verification.protocolVersion ? ` Protocol ${verification.protocolVersion}.` : ""}`,
          );
          record.states.authenticated = {
            status: "not_verified",
            detail: suppliedRequiredNames.length
              ? `Required environment configuration was supplied for ${suppliedRequiredNames.join(", ")}; MCP initialization does not independently verify authentication.`
              : "No independent authentication state was reported by the MCP initialize handshake.",
            at: new Date().toISOString(),
          };
        } else {
          record.states.startup_verified = plan.entry.url
            ? {
                status: "not_applicable",
                detail: "Remote endpoint; no local server process was started.",
              }
            : !verification.startupVerified
              ? {
                  status: "failed",
                  detail: verification.detail,
                  at: new Date().toISOString(),
                }
              : completed(
                  "The server process started; protocol initialization did not complete.",
                );
          record.states.connection_verified = {
            status: "failed",
            detail: verification.detail,
            at: new Date().toISOString(),
          };
        }
        phase = "configuration";
        const installRecord = record;
        if (!installRecord)
          throw new Error("Installation state was not initialized.");
        await withFileLock(adapter.configPath(), async () => {
          const currentAtCommit = await readCurrentConfiguration(adapter);
          const matchesAtCommit = await findExistingMatches(
            candidate.registryIdentifier,
            plan.entry,
            plan.packageIdentifier,
            detectionAdapters,
            stateStore,
          );
          const initialMatchKeys = new Set(
            initialMatches.map(
              (match) =>
                `${match.configPath}\0${match.name}\0${match.classification}`,
            ),
          );
          const newMatches = matchesAtCommit.filter(
            (match) =>
              !initialMatchKeys.has(
                `${match.configPath}\0${match.name}\0${match.classification}`,
              ),
          );
          const unapprovedNewMatches = newMatches.filter(
            (match) =>
              match.classification !== "possible_duplicate" || !options.yes,
          );
          if (unapprovedNewMatches.length)
            throw new Error(
              `Configuration changed during installation; new possible or conflicting registrations were found. Rerun after reviewing them: ${formatExistingMatches(unapprovedNewMatches)}`,
            );
          const priorRecordAtCommit = await stateStore.get(
            candidate.registryIdentifier,
            adapter.id,
            adapter.configPath(),
          );
          const persistedMatchWithCredentials = await adapter.verify(
            plan.entry,
          );
          if (
            currentAtCommit[plan.entry.name] &&
            !persistedMatchWithCredentials.verified &&
            !(
              priorRecordAtCommit?.configName === plan.entry.name &&
              priorRecordAtCommit.configPath === adapter.configPath() &&
              (priorRecordAtCommit.configScope ?? "user") ===
                adapter.configScope()
            )
          ) {
            throw new Error(
              `A different server named ${plan.entry.name} is already configured for ${adapter.displayName}. Remove or rename it first.`,
            );
          }
          try {
            if (!persistedMatchWithCredentials.verified)
              await adapter.add(plan.entry, operationId);
            const verificationResult = await adapter.verify(plan.entry);
            if (!verificationResult.verified) {
              if (!currentAtCommit[plan.entry.name])
                await adapter
                  .remove(plan.entry.name, operationId)
                  .catch(() => false);
              installRecord.states.configured = {
                status: "failed",
                detail: verificationResult.detail,
                at: new Date().toISOString(),
              };
              installRecord.lastError = installRecord.states.configured.detail;
              await stateStore.put(installRecord);
              throw new Error(
                `${adapter.displayName} configuration verification failed; MCPGet attempted to roll back the registration. ${verificationResult.detail}`,
              );
            }
            installRecord.states.configured = completed(
              verificationResult.detail,
            );
            if (
              adapter.id === "claude-code" &&
              adapter.configScope() === "project"
            ) {
              installRecord.states.setup_required = {
                status: "setup_required",
                detail:
                  "Project-scoped MCP configuration is written; Claude Code workspace trust and project-server approval remain required.",
                at: new Date().toISOString(),
              };
              installRecord.states.client_connection_verified = {
                status: "not_verified",
                detail:
                  "Claude Code runtime loading and project approval have not been independently observed.",
                at: new Date().toISOString(),
              };
            }
            if (operationId)
              await journal.advance(operationId, "configuration_written");
            if (credentialSetupComplete) {
              installRecord.states.setup_required = completed(
                `Required environment configuration independently verified for: ${suppliedRequiredNames.join(", ")}.`,
              );
            }
            phase = "complete";
            if (installRecord.strategy === "ephemeral")
              installRecord.states.execution_registered = completed(
                "Ephemeral command recorded in the selected client; no persistent package installation was performed.",
              );
            if (
              installRecord.strategy === "managed" &&
              installRecord.installationPath
            ) {
              await updateManagedMetadata(
                {
                  directory: installRecord.installationPath,
                  packageIdentifier: installRecord.packageIdentifier!,
                  installedVersion: installRecord.installedVersion!,
                  command: plan.entry.command!,
                  args: plan.entry.args ?? [],
                  reused: false,
                  lifecycleScriptsEnabled,
                },
                {
                  serverIdentifier: installRecord.serverIdentifier,
                  serverName: installRecord.displayName,
                  client: adapter.id,
                  configurationEntry: installRecord.configName,
                  verificationStatus:
                    installRecord.states.connection_verified.status,
                  ...(installRecord.states.connection_verified.status ===
                  "completed"
                    ? {
                        lastVerifiedAt:
                          installRecord.states.connection_verified.at,
                      }
                    : {}),
                },
              );
              if (operationId)
                await journal.advance(operationId, "metadata_updated");
            }
            await stateStore.put(installRecord);
            if (operationId)
              await journal.advance(operationId, "state_updated");
          } catch (error) {
            if (
              installRecord.strategy === "managed" &&
              installRecord.installationPath &&
              !currentAtCommit[plan.entry.name]
            ) {
              await releaseManagedAssociation(
                installRecord.installationPath,
                installRecord.serverIdentifier,
                adapter.id,
                installRecord.configName,
              );
            }
            throw error;
          }
        });
        if (
          record.states.authenticated.status === "authentication_required" &&
          adapter.authenticate
        ) {
          if (
            process.stdin.isTTY &&
            process.stdout.isTTY &&
            (await confirm(
              "Codex reports authentication is required. Run Codex's own OAuth login now? [y/N] ",
              json ? process.stderr : process.stdout,
            ))
          ) {
            try {
              await adapter.authenticate(plan.entry.name);
              record.states.authenticated = {
                status: "not_verified",
                detail:
                  "Codex reported that its OAuth login flow completed; authentication with the MCP server was not independently verified.",
                at: new Date().toISOString(),
              };
              record.states.setup_required = {
                status: "not_verified",
                detail:
                  "Codex reported OAuth login completion; MCPGet has not independently confirmed authentication with the server.",
                at: new Date().toISOString(),
              };
              record.states.connection_verified = {
                status: "not_verified",
                detail:
                  "Authentication completed in Codex; MCP connection could not be independently verified by MCPGet.",
                at: new Date().toISOString(),
              };
            } catch {
              record.states.authenticated = {
                status: "failed",
                detail:
                  "Codex OAuth login did not complete. Retry with `codex mcp login`.",
                at: new Date().toISOString(),
              };
            }
          }
        } else if (
          record.states.authenticated.status === "authentication_required" &&
          adapter.id === "cursor"
        ) {
          record.states.authenticated.detail =
            "Complete Cursor's client-managed OAuth sign-in after opening Cursor. MCPGet cannot inspect Cursor's stored credentials or confirm later sign-in.";
        }
        await stateStore.put(record);
        if (operationId) await journal.complete(operationId);
        const incompleteCredentialNames = [
          ...credentials.skipped,
          ...credentials.unsupported,
        ];
        if (setupPending) {
          const setupMessage = [
            incompleteCredentialNames.length
              ? `Missing required setup: ${incompleteCredentialNames.join(", ")}.`
              : "",
            credentials.oauth.length
              ? `OAuth setup remains required: ${credentials.oauth.join(", ")}.`
              : "",
          ]
            .filter(Boolean)
            .join(" ");
          record.lastError = setupMessage;
          await stateStore.put(record);
          if (operationId) await journal.complete(operationId);
          if (json) {
            printJson(
              failureResponse(
                "install",
                new CliError("MISSING_REQUIRED_INPUT", setupMessage),
                discoveryWarnings(),
                {
                  record: installJsonData(
                    record,
                    discoveryMetadata,
                    credentialProvision,
                  ),
                },
              ),
            );
          } else {
            console.log(`\n${reportStates(record)}`);
          }
          process.exitCode = EXIT_CODES.missingRequiredInput;
          return;
        }
        if (verification.status !== "connection_verified") {
          const verificationMessage =
            verification.detail || "MCP verification did not complete.";
          record.lastError = verificationMessage;
          await stateStore.put(record);
          if (operationId) await journal.complete(operationId);
          if (json) {
            printJson(
              failureResponse(
                "install",
                new CliError("OPERATIONAL_FAILURE", verificationMessage),
                discoveryWarnings(),
                {
                  record: installJsonData(
                    record,
                    discoveryMetadata,
                    credentialProvision,
                  ),
                },
              ),
            );
          } else {
            console.log(`\n${reportStates(record)}`);
          }
          process.exitCode = EXIT_CODES.operationalFailure;
          return;
        }
        if (json) {
          printJson(
            successResponse(
              "install",
              installJsonData(record, discoveryMetadata, credentialProvision),
              discoveryWarnings(),
            ),
          );
        } else {
          console.log(`\n${reportStates(record)}`);
        }
      } catch (error) {
        if (error instanceof CredentialPromptCancelled) {
          if (record) {
            record.states.setup_required = {
              status: "setup_required",
              detail:
                "Credential entry was cancelled. The persistent installation was retained; client configuration was not changed.",
              at: new Date().toISOString(),
            };
            await stateStore.put(record);
            if (!json) console.log(reportStates(record));
          }
          if (json) {
            printJson(
              failureResponse(
                "install",
                new CliError(
                  "CANCELLED",
                  "Credential entry was cancelled. No client configuration was changed.",
                ),
                discoveryWarnings(),
                record
                  ? {
                      record: installJsonData(
                        record,
                        discoveryMetadata,
                        credentialProvision,
                      ),
                    }
                  : discoveryMetadata?.status === "partial"
                    ? { discovery: discoveryMetadata }
                    : undefined,
              ),
            );
          } else {
            console.log(
              "Credential entry cancelled; the installation remains available and no client configuration was changed.",
            );
          }
          process.exitCode = EXIT_CODES.cancelled;
          return;
        }
        const message =
          error instanceof RegistryError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Installation failed.";
        if (record) {
          record.lastError = message;
          if (record.states.install_confirmed.status === "completed") {
            if (
              phase === "installation" &&
              record.strategy === "managed" &&
              record.states.installed.status !== "completed"
            ) {
              record.states.installed = {
                status: "failed",
                detail: message,
                at: new Date().toISOString(),
              };
            } else if (
              phase === "verification" &&
              record.states.connection_verified.status !== "failed"
            ) {
              record.states.connection_verified = {
                status: "failed",
                detail: "MCP verification did not complete.",
                at: new Date().toISOString(),
              };
            } else if (
              phase === "configuration" &&
              record.states.configured.status !== "completed"
            ) {
              record.states.configured = {
                status: "failed",
                detail: message,
                at: new Date().toISOString(),
              };
            }
          }
          if (record.states.install_confirmed.status === "completed")
            await stateStore.put(record).catch(() => undefined);
          if (!json) console.error(reportStates(record));
        }
        const cliError =
          error instanceof CliError
            ? error
            : isManagedNpmCancelledError(error)
              ? new CliError("CANCELLED", message)
              : error instanceof RemoteEndpointSecurityError
                ? new CliError("INVALID_INPUT", message)
                : /Unsupported client|Persistent managed installation is currently supported|not supported yet|no supported package|multiple installation sources|Invalid selection|Interactive (selection|confirmation)/i.test(
                      message,
                    )
                  ? /Interactive (selection|confirmation)|required/i.test(
                      message,
                    )
                    ? new CliError("MISSING_REQUIRED_INPUT", message)
                    : /Unsupported client|Persistent managed installation is currently supported|not supported yet|no supported package|multiple installation sources/i.test(
                          message,
                        )
                      ? new CliError("UNSUPPORTED_OPERATION", message)
                      : new CliError("INVALID_INPUT", message)
                  : /invalid|cannot contain|not a valid|Package reference is invalid|No matching Registry candidates|No candidate declares|Remote MCP endpoints must use HTTPS/i.test(
                        message,
                      )
                    ? new CliError("INVALID_INPUT", message)
                    : new CliError("OPERATIONAL_FAILURE", message);
        if (json) {
          printJson(
            failureResponse(
              "install",
              cliError,
              discoveryWarnings(),
              record
                ? {
                    record: installJsonData(
                      record,
                      discoveryMetadata,
                      credentialProvision,
                    ),
                  }
                : discoveryMetadata?.status === "partial"
                  ? { discovery: discoveryMetadata }
                  : undefined,
            ),
          );
        } else if (!(
          record &&
          phase === "configuration" &&
          record.states.configured.status === "failed"
        )) {
          console.error(
            `${phase === "configuration" ? "Configuration failed" : "Install failed"}: ${safeTerminalText(message)}`,
          );
        }
        process.exitCode =
          isManagedNpmCancelledError(error) && error.signal === "SIGTERM"
            ? 143
            : exitCodeForError(cliError);
      }
    });
}

function isManagedNpmCancelledError(
  error: unknown,
): error is Error & { signal: NodeJS.Signals | "ABORT" } {
  return (
    error instanceof Error &&
    error.name === "ManagedNpmCancelledError" &&
    "signal" in error &&
    ["SIGINT", "SIGTERM", "ABORT"].includes(String(error.signal))
  );
}

async function findExistingMatches(
  candidateId: string,
  proposed: ServerConfiguration,
  packageIdentifier: string | undefined,
  adapters: ReturnType<typeof getClientAdapter>[],
  stateStore: InstallationStateStore,
): Promise<ExistingServerMatch[]> {
  const registrations: ExistingServerRegistration[] = [];
  for (const adapter of adapters) {
    if (adapter.readRegistrations) {
      try {
        registrations.push(...(await adapter.readRegistrations()));
      } catch (error) {
        if (
          adapter.id === "codex" &&
          error instanceof Error &&
          /(?:user|project)-scope configuration is missing/i.test(error.message)
        )
          continue;
        throw error;
      }
    } else {
      const servers = await readCurrentConfiguration(adapter);
      registrations.push(
        ...Object.values(servers).map((entry) =>
          normalizeServerRegistration(
            adapter.id,
            adapter.configPath(),
            adapter.configScope(),
            entry,
          ),
        ),
      );
    }
  }
  const sharedRegistrations = registrations.filter(
    (registration, index) =>
      registrations.findIndex(
        (candidate) =>
          candidate.configPath === registration.configPath &&
          candidate.name === registration.name,
      ) === index,
  );
  return detectExistingServerMatches(
    candidateId,
    proposed,
    packageIdentifier,
    sharedRegistrations,
    await stateStore.all(),
  );
}

function existingMatchData(matches: ExistingServerMatch[]) {
  return matches.map((match) => ({
    classification: match.classification,
    name: safeTerminalText(match.name, 120),
    scope: match.configScope,
    configPath: safeTerminalText(match.configPath, 500),
    reason: safeTerminalText(match.reason, 240),
  }));
}

function formatExistingMatches(matches: ExistingServerMatch[]): string {
  return matches
    .map(
      (match) =>
        `- ${safeTerminalText(match.classification)}: ${safeTerminalText(match.name, 120)} (${safeTerminalText(match.configScope)} scope, ${safeTerminalText(match.configPath, 300)}): ${safeTerminalText(match.reason, 240)}`,
    )
    .join("\n");
}

async function resolve(
  input: string,
  candidateId?: string,
  source?: CandidateSource,
  candidateSelector: CandidateSelector = selectOne,
  onDiscovery?: (metadata: DiscoveryMetadata) => void,
  showDiscoveryWarning = true,
): Promise<ServerCandidate> {
  const registry = source ?? new OfficialRegistryAdapter();
  if (candidateId) {
    if (registry.getByIdentifier) return registry.getByIdentifier(candidateId);
    return new OfficialRegistryAdapter().getByIdentifier(candidateId);
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input) && !/^https:\/\//i.test(input))
    throw new Error("Remote MCP endpoints must use HTTPS.");
  if (/^https:\/\//i.test(input)) {
    const url = parsePublicHttpsEndpoint(input);
    return {
      name: url.hostname,
      title: url.hostname,
      registryIdentifier: url.toString(),
      operational: {
        deploymentModels: ["Remote endpoint"],
        transports: ["streamable-http"],
        packages: [],
        remoteEndpoints: [url.toString()],
        configurationInputs: [],
        authentication: "Unknown",
        clientCompatibility: "Unknown",
        setupComplexity: "Unknown",
      },
      sourceRegistry: "User supplied",
      sourceRecordUrl: "Explicit user-supplied endpoint",
    };
  }
  if (/^(npm|pypi|oci):/.test(input)) {
    const [registryType, ...rest] = input.split(":");
    let identifier = rest.join(":");
    let version: string | undefined;
    if (registryType?.toLowerCase() === "npm") {
      const versionAt = identifier.lastIndexOf("@");
      const nameEnd = identifier.startsWith("@") ? identifier.indexOf("/") : 0;
      if (versionAt > nameEnd && versionAt < identifier.length - 1) {
        version = identifier.slice(versionAt + 1);
        identifier = identifier.slice(0, versionAt);
      }
    } else if (registryType?.toLowerCase() === "pypi") {
      const versionAt = identifier.indexOf("==");
      if (versionAt > 0) {
        version = identifier.slice(versionAt + 2);
        identifier = identifier.slice(0, versionAt);
      }
    }
    if (!identifier || /[\s;&|<>]/.test(identifier))
      throw new Error("Package reference is invalid.");
    return {
      name: identifier,
      registryIdentifier: input,
      operational: {
        deploymentModels: ["Local package"],
        transports: ["stdio"],
        packages: [
          {
            ...(registryType ? { registryType } : {}),
            identifier,
            ...(version ? { version } : {}),
          },
        ],
        remoteEndpoints: [],
        configurationInputs: [],
        authentication: "Unknown",
        clientCompatibility: "Unknown",
        setupComplexity: "Unknown",
      },
      sourceRegistry: "User supplied",
      sourceRecordUrl: "Explicit user-supplied package reference",
    };
  }
  if (input.includes("/") && !input.includes("\\")) {
    if (!registry.getByIdentifier)
      throw new CliError(
        "UNSUPPORTED_OPERATION",
        "Exact Registry candidate lookup is unavailable for this discovery source.",
      );
    return registry.getByIdentifier(input);
  }
  const result = await discoverByServiceUrl(input, registry);
  onDiscovery?.(result.discovery);
  if (
    result.discovery.status === "partial" &&
    showDiscoveryWarning &&
    process.stdin.isTTY &&
    process.stdout.isTTY
  ) {
    console.log(`WARNING: ${PARTIAL_DISCOVERY_WARNING}`);
  }
  if (result.evaluations.length === 0)
    throw new Error(
      result.discovery.status === "partial"
        ? `${PARTIAL_DISCOVERY_WARNING} No matching Registry candidates were retrieved. Try a more specific service name or an exact Registry identifier.`
        : "No matching Registry candidates were found. Try an exact Registry identifier or package reference.",
    );
  const installable = result.evaluations.filter(
    (item) =>
      item.candidate.operational.packages.length ||
      item.candidate.operational.remoteEndpoints.some((endpoint) =>
        endpoint.startsWith("https://"),
      ),
  );
  if (installable.length === 0)
    throw new Error(
      result.discovery.status === "partial"
        ? `${PARTIAL_DISCOVERY_WARNING} No retrieved candidate declares a supported installation source. Try a more specific service name.`
        : "No candidate declares a supported installation source.",
    );
  if (installable.length > 1 || result.discovery.status === "partial") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new CliError(
        "INVALID_INPUT",
        result.discovery.status === "partial"
          ? `${PARTIAL_DISCOVERY_WARNING} Additional candidates may exist. Explicitly select a Registry candidate with --candidate <registry-id>.\n${buildCandidateSelectionError(installable, result.evaluations)}`
          : buildCandidateSelectionError(installable, result.evaluations),
      );
    }
    return selectInstallableCandidate(
      installable,
      result.evaluations,
      candidateSelector,
    );
  }
  return installable[0]!.candidate;
}

export async function selectInstallableCandidate(
  installable: CandidateEvaluation[],
  allEvaluations: CandidateEvaluation[],
  selector: CandidateSelector = selectOne,
): Promise<ServerCandidate> {
  const choicesToShow = installable.slice(0, 8);
  const choices = choicesToShow.map(
    (item) =>
      `${item.candidate.registryIdentifier} — ${item.candidate.title ?? item.candidate.name}`,
  );
  const presentation = createDuplicateSelectionPresentation(
    choicesToShow,
    allEvaluations,
    choices,
  );
  const answer = await selector(
    choices.length === 1
      ? "Select this candidate to continue:"
      : presentation
        ? `Choose a candidate (1–${choices.length}):`
        : "Several installable candidates match. Choose one:",
    choices,
    presentation,
  );
  const selectedIndex = choices.indexOf(answer);
  if (selectedIndex < 0)
    throw new Error("Invalid selection; no changes were made.");
  return choicesToShow[selectedIndex]!.candidate;
}

export function formatCandidateSelectionLines(
  choices: string[],
  presentation?: CandidateSelectionPresentation,
): string[] {
  const lines = (presentation?.heading ?? []).map((line) =>
    safeTerminalText(line, 200),
  );
  choices.forEach((choice, index) => {
    const label = presentation?.labels[index] ?? choice;
    lines.push(`  ${index + 1}. ${safeTerminalText(label, 130)}`);
    const detail = presentation?.details[index];
    if (detail) lines.push(`     ${safeTerminalText(detail, 160)}`);
  });
  lines.push(
    ...(presentation?.footer ?? []).map((line) => safeTerminalText(line, 200)),
  );
  return lines;
}

function createDuplicateSelectionPresentation(
  candidates: CandidateEvaluation[],
  allEvaluations: CandidateEvaluation[],
  choices: string[],
): CandidateSelectionPresentation | undefined {
  const grouped = new Map<string, CandidateEvaluation[]>();
  for (const item of candidates) {
    if (!item.duplicate) continue;
    const group = grouped.get(item.duplicate.groupId) ?? [];
    group.push(item);
    grouped.set(item.duplicate.groupId, group);
  }
  const groups = [...grouped.values()].filter((group) => group.length > 1);
  if (!groups.length) return undefined;

  const candidateIndexes = new Map(
    candidates.map((item, index) => [
      item.candidate.registryIdentifier,
      index + 1,
    ]),
  );
  const duplicateIdentifiers = new Set(
    groups.flatMap((group) =>
      group.map((item) => item.candidate.registryIdentifier),
    ),
  );
  const groupSources = groups.map((group) =>
    findGroupSharedSources(group, candidateIndexes),
  );
  const sharedNpmPackageAcrossGroup =
    groups.length === 1 &&
    groupSources[0]!.some(
      (source) =>
        source.source.toLowerCase().startsWith("npm:") &&
        source.choiceIndexes.size === groups[0]!.length,
    );
  const explanation =
    groups.length === 1 && sharedNpmPackageAcrossGroup
      ? "These Registry entries share the same npm package and may represent the same integration; this is suggestive metadata, not a security verdict."
      : "Duplicate metadata suggests entries within each group may represent the same integration; this is not a security verdict.";

  const fullGroups = new Map<string, CandidateEvaluation[]>();
  for (const item of allEvaluations) {
    if (!item.duplicate) continue;
    const group = fullGroups.get(item.duplicate.groupId) ?? [];
    group.push(item);
    fullGroups.set(item.duplicate.groupId, group);
  }

  const labels = candidates.map((item, index) =>
    duplicateIdentifiers.has(item.candidate.registryIdentifier)
      ? safeTerminalText(item.candidate.registryIdentifier, 130)
      : choices[index]!,
  );
  const details = candidates.map((item) => {
    if (
      !item.duplicate ||
      !duplicateIdentifiers.has(item.candidate.registryIdentifier)
    )
      return undefined;
    const registryVersion = item.candidate.version;
    if (!registryVersion) return undefined;
    const group = fullGroups.get(item.duplicate.groupId) ?? [];
    const versionLabel = registryVersion.replace(/^v/i, "");
    const versionText = `v${safeTerminalText(versionLabel, 80)}`;
    return isUnambiguouslyNewestRegistryVersion(item, group)
      ? `${versionText} · Newer Registry version`
      : versionText;
  });

  const footer =
    groups.length === 1
      ? formatSingleDuplicateGroupFooter(groups[0]!, groupSources[0]!)
      : formatMultipleDuplicateGroupsFooter(
          groups,
          groupSources,
          candidateIndexes,
        );
  return {
    heading: [
      `Possible duplicate entries (${groups.reduce((count, group) => count + group.length, 0)})`,
      explanation,
    ],
    labels,
    details,
    footer,
  };
}

function findGroupSharedSources(
  group: CandidateEvaluation[],
  candidateIndexes: Map<string, number>,
): Array<{ source: string; choiceIndexes: Set<number> }> {
  const sources = new Map<
    string,
    { source: string; choiceIndexes: Set<number> }
  >();
  for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < group.length;
      rightIndex += 1
    ) {
      const left = group[leftIndex]!;
      const right = group[rightIndex]!;
      const leftChoice = candidateIndexes.get(
        left.candidate.registryIdentifier,
      );
      const rightChoice = candidateIndexes.get(
        right.candidate.registryIdentifier,
      );
      if (leftChoice === undefined || rightChoice === undefined) continue;
      for (const rawSource of findSharedPackageSources(
        left.candidate,
        right.candidate,
      )) {
        const source = rawSource.split(" (package versions ")[0]!;
        const key = source.toLowerCase();
        const entry = sources.get(key) ?? {
          source,
          choiceIndexes: new Set<number>(),
        };
        entry.choiceIndexes.add(leftChoice);
        entry.choiceIndexes.add(rightChoice);
        sources.set(key, entry);
      }
    }
  }
  return [...sources.values()];
}

function formatSingleDuplicateGroupFooter(
  group: CandidateEvaluation[],
  sources: Array<{ source: string; choiceIndexes: Set<number> }>,
): string[] {
  if (!sources.length)
    return ["No shared installation package was identified."];
  return sources.map(({ source, choiceIndexes }) => {
    const label = formatSharedSourceLabel(source);
    const allChoicesParticipate = choiceIndexes.size === group.length;
    const associatedChoices = [...choiceIndexes].sort((a, b) => a - b);
    return allChoicesParticipate
      ? label
      : `${label} (candidates ${associatedChoices.join(", ")})`;
  });
}

function formatMultipleDuplicateGroupsFooter(
  groups: CandidateEvaluation[][],
  groupSources: Array<Array<{ source: string; choiceIndexes: Set<number> }>>,
  candidateIndexes: Map<string, number>,
): string[] {
  const lines = ["Shared sources by duplicate group:"];
  groups.forEach((group, groupIndex) => {
    const sourceEntries = groupSources[groupIndex] ?? [];
    const groupNumbers = group
      .map((item) => candidateIndexes.get(item.candidate.registryIdentifier))
      .filter((index): index is number => index !== undefined)
      .sort((a, b) => a - b);
    const groupLabel = `Group ${groupIndex + 1}`;
    if (!sourceEntries.length) {
      lines.push(
        `  ${groupLabel} (candidates ${groupNumbers.join(", ")}): no shared package identified.`,
      );
      return;
    }
    for (const { source, choiceIndexes: relatedChoices } of sourceEntries) {
      lines.push(
        `  ${groupLabel}: ${formatSharedSourceLabel(source)} (candidates ${[...relatedChoices].sort((a, b) => a - b).join(", ")})`,
      );
    }
  });
  return lines;
}

function formatSharedSourceLabel(source: string): string {
  const separator = source.indexOf(":");
  if (separator < 0) return `Shared installation source: ${source}`;
  const registryType = source.slice(0, separator);
  const identifier = source.slice(separator + 1);
  return registryType.toLowerCase() === "npm"
    ? `Shared package: ${identifier}`
    : `Shared installation source: ${registryType}:${identifier}`;
}

function isUnambiguouslyNewestRegistryVersion(
  candidate: CandidateEvaluation,
  group: CandidateEvaluation[],
): boolean {
  const version = candidate.candidate.version;
  if (!version || group.length < 2) return false;
  if (group.some((item) => !item.candidate.version)) return false;
  if (group.filter((item) => item.candidate.version === version).length !== 1)
    return false;
  const otherVersions = [
    ...new Set(
      group
        .map((item) => item.candidate.version)
        .filter(
          (other): other is string => Boolean(other) && other !== version,
        ),
    ),
  ];
  if (!otherVersions.length) return false;
  const notes = group
    .map((item) => item.duplicate?.versionNote)
    .filter((note): note is string => Boolean(note));
  return otherVersions.every((other) =>
    notes.some((note) =>
      note.includes(
        `Version comparison: ${version} appears newer than ${other}.`,
      ),
    ),
  );
}

export function formatDuplicateWarnings(
  candidates: CandidateEvaluation[],
  allEvaluations: CandidateEvaluation[] = candidates,
): string[] {
  const byIdentifier = new Map(
    allEvaluations.map((item) => [item.candidate.registryIdentifier, item]),
  );
  const seenPairs = new Set<string>();
  const pairWarnings: string[] = [];

  for (const item of candidates) {
    if (!item.duplicate) continue;
    for (const relatedIdentifier of item.duplicate.relatedIdentifiers) {
      if (relatedIdentifier === item.candidate.registryIdentifier) continue;
      const pair = [
        item.candidate.registryIdentifier,
        relatedIdentifier,
      ].sort();
      const pairKey = pair.join("\0");
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const related = byIdentifier.get(relatedIdentifier);
      const sharedSources = related
        ? findSharedPackageSources(item.candidate, related.candidate)
        : [];
      const warning =
        `Possible duplicate Registry entries ${safeTerminalText(pair[0]!, 140)} and ${safeTerminalText(pair[1]!, 140)} may represent the same integration` +
        (sharedSources.length
          ? `; shared installation source: ${sharedSources.join(", ")}`
          : item.duplicate.reasons.length
            ? `; relationship evidence: ${item.duplicate.reasons.map((reason) => safeTerminalText(reason, 80)).join(", ")}`
            : "") +
        (item.duplicate.versionNote
          ? `; ${safeTerminalText(item.duplicate.versionNote, 140)}`
          : "") +
        ".";
      pairWarnings.push(warning);
    }
  }

  if (!pairWarnings.length) return [];
  return [
    "Warning: duplicate metadata is suggestive only; entries may represent the same integration, but this does not prove maliciousness or identical behaviour.",
    ...pairWarnings,
  ];
}

function buildCandidateSelectionError(
  installable: CandidateEvaluation[],
  allEvaluations: CandidateEvaluation[],
): string {
  const prefix =
    "Multiple installable candidates match. Retry with --candidate using an exact Registry identifier.";
  const warnings = formatDuplicateWarnings(
    installable.slice(0, 8),
    allEvaluations,
  );
  if (warnings.length) {
    const item = installable
      .slice(0, 8)
      .find((candidate) => candidate.duplicate?.relatedIdentifiers.length);
    const relatedIdentifier = item?.duplicate?.relatedIdentifiers.find(
      (identifier) => identifier !== item.candidate.registryIdentifier,
    );
    if (item && relatedIdentifier) {
      const related = allEvaluations.find(
        (candidate) =>
          candidate.candidate.registryIdentifier === relatedIdentifier,
      );
      const sources = related
        ? findSharedPackageSources(item.candidate, related.candidate)
        : [];
      return [
        prefix,
        `Possible duplicate entries ${safeTerminalText(item.candidate.registryIdentifier, 90)} and ${safeTerminalText(relatedIdentifier, 90)} may represent the same integration`,
        sources.length ? `They share ${sources.join(", ")}.` : "",
        item.duplicate?.versionNote
          ? safeTerminalText(item.duplicate.versionNote, 100)
          : "",
        "Duplicate metadata is suggestive only; this does not prove maliciousness or identical behaviour.",
      ]
        .filter(Boolean)
        .join(" ");
    }
  }

  const candidatesWithSources = installable
    .slice(0, 8)
    .map(
      (item) =>
        `${safeTerminalText(item.candidate.registryIdentifier, 100)} (${availablePackageSources(item)})`,
    );
  return `${prefix} Candidates and sources: ${candidatesWithSources.join("; ")}.`;
}

function findSharedPackageSources(
  left: ServerCandidate,
  right: ServerCandidate,
): string[] {
  const rightPackages = new Map(
    right.operational.packages
      .filter(
        (pkg) =>
          typeof pkg.registryType === "string" &&
          typeof pkg.identifier === "string",
      )
      .map((pkg) => [
        `${pkg.registryType!.toLowerCase()}:${pkg.identifier!.toLowerCase()}`,
        pkg,
      ]),
  );
  const sources: string[] = [];
  for (const pkg of left.operational.packages) {
    if (!pkg.registryType || !pkg.identifier) continue;
    const key = `${pkg.registryType.toLowerCase()}:${pkg.identifier.toLowerCase()}`;
    const shared = rightPackages.get(key);
    if (!shared) continue;
    const packageVersions = [pkg.version, shared.version].filter(
      (version): version is string => Boolean(version),
    );
    const versionDetail =
      packageVersions.length === 2 && packageVersions[0] !== packageVersions[1]
        ? ` (package versions ${packageVersions.map((version) => safeTerminalText(version, 60)).join(" and ")})`
        : "";
    sources.push(
      `${safeTerminalText(pkg.registryType.toLowerCase(), 40)}:${safeTerminalText(pkg.identifier, 120)}${versionDetail}`,
    );
  }
  return [...new Set(sources)];
}

function availablePackageSources(item: CandidateEvaluation): string {
  const sources = item.candidate.operational.packages.flatMap((pkg) =>
    pkg.registryType && pkg.identifier
      ? [
          `${safeTerminalText(pkg.registryType.toLowerCase(), 40)}:${safeTerminalText(pkg.identifier, 120)}`,
        ]
      : [],
  );
  if (
    item.candidate.operational.remoteEndpoints.some((endpoint) =>
      endpoint.startsWith("https://"),
    )
  )
    sources.push("remote");
  return sources.length
    ? [...new Set(sources)].join(", ")
    : "source unspecified";
}

async function confirm(
  question: string,
  output: Writable = process.stdout,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Interactive confirmation is required. Run this command in a terminal; no changes were made.",
    );
  const rl = createInterface({ input: process.stdin, output });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
    process.stdin.pause();
  }
}
async function selectOne(
  question: string,
  choices: string[],
  presentation?: CandidateSelectionPresentation,
): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      `Interactive selection is required. Run this command in a terminal. Options: ${choices.join("; ")}`,
    );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const line of formatCandidateSelectionLines(choices, presentation))
      console.log(line);
    const prompt = presentation ? question : `${question} Enter a number:`;
    const answer = await rl.question(`${prompt} `);
    const index = Number(answer.trim()) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= choices.length)
      throw new Error("Invalid selection; no changes were made.");
    return choices[index]!;
  } finally {
    rl.close();
    process.stdin.pause();
  }
}

function completed(detail: string): InstallationStep {
  return { status: "completed", detail, at: new Date().toISOString() };
}

async function readCurrentConfiguration(
  adapter: ReturnType<typeof getClientAdapter>,
): Promise<Record<string, ServerConfiguration>> {
  try {
    return await adapter.read();
  } catch (error) {
    if (
      adapter.id === "codex" &&
      error instanceof Error &&
      /(?:user|project)-scope configuration is missing/i.test(error.message)
    )
      return {};
    throw error;
  }
}

async function preflightClientConfiguration(
  adapter: ReturnType<typeof getClientAdapter>,
  journal: OperationJournal,
): Promise<Record<string, ServerConfiguration>> {
  try {
    return await withFileLock(adapter.configPath(), async () => {
      await ensureClientConfigurationLifecycle(adapter, journal);
      return readCurrentConfiguration(adapter);
    });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "Unknown configuration error.";
    const recovery = reason.includes('Run "mcpget ')
      ? ""
      : "Repair the existing configuration or its file permissions, then rerun the install.";
    throw new CliError(
      "OPERATIONAL_FAILURE",
      `${adapter.displayName} cannot yet register this MCP server. Configuration preflight failed: ${reason}${recovery ? ` ${recovery}` : ""}`,
    );
  }
}

async function ensureClientConfigurationLifecycle(
  adapter: ReturnType<typeof getClientAdapter>,
  journal: OperationJournal,
  currentOperationId?: string,
): Promise<void> {
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
    currentOperationId,
    () =>
      recoverPendingOperations({
        adapters: [adapter],
        configPath: adapter.configPath(),
        allowMetadataLessBackupReconciliation: true,
        skipPackageCleanup: true,
        journal,
      }),
  );
}

export function mergeRequiredInputs(
  registryInputs: RegistryInputRequirement[],
  documentedInputs: RegistryInputRequirement[],
): RegistryInputRequirement[] {
  const inputs = new Map<string, RegistryInputRequirement>();
  for (const input of [...registryInputs, ...documentedInputs]) {
    if (input.required !== true) continue;
    const prior = inputs.get(input.name);
    const description = input.description ?? prior?.description;
    const merged = {
      ...prior,
      ...input,
      required: true,
      secret: input.secret === true || prior?.secret === true,
      ...(description !== undefined ? { description } : {}),
    };
    inputs.set(input.name, {
      ...merged,
      kind: classifyCredentialKind(merged),
    });
  }
  return [...inputs.values()].slice(0, 12);
}

function isOAuthInput(input: RegistryInputRequirement): boolean {
  return /oauth/i.test(`${input.name} ${input.description ?? ""}`);
}

export function installJsonData(
  record: InstallationRecord,
  discovery?: DiscoveryMetadata,
  credentialProvision?: {
    status: "configured" | "missing" | "conflict" | "none";
    suppliedNames: string[];
    missingNames: string[];
    conflictNames: string[];
    replacedNames: string[];
    kinds: Record<string, "secret" | "directory_path" | "configuration">;
  },
): Record<string, unknown> {
  return {
    installation: {
      id: record.id,
      serverName: record.displayName,
      client: record.client,
      strategy: record.strategy,
      ...(record.packageIdentifier
        ? { packageIdentifier: record.packageIdentifier }
        : {}),
      ...(record.installedVersion
        ? { installedVersion: record.installedVersion }
        : {}),
      lifecycleScriptsEnabled: record.lifecycleScriptsEnabled === true,
      ...(record.remoteEndpoint
        ? {
            remoteEndpoint: record.remoteEndpoint,
            remoteEndpointTrust: record.remoteEndpointTrust ?? "pending",
          }
        : {}),
    },
    configuration: {
      name: record.configName,
      scope: record.configScope ?? "user",
      status: record.states.configured.status,
    },
    ...(credentialProvision ? { credentials: credentialProvision } : {}),
    states: record.states,
    ...(discovery ? { discovery } : {}),
    ...(record.lastError
      ? { partial: { lastError: safeTerminalText(record.lastError, 220) } }
      : {}),
  };
}

export function reportStates(record: InstallationRecord): string {
  const rows = Object.entries(record.states).map(
    ([name, step]) =>
      `- [${step.status.toUpperCase()}] ${name}: ${safeTerminalText(step.detail, name === "configured" && step.status === "failed" ? 260 : 220)}`,
  );
  const retainedInstallation =
    record.strategy === "managed" &&
    record.states.installed.status === "completed"
      ? "; PERSISTENT INSTALLATION IS RETAINED"
      : "";
  const result =
    record.states.configured.status === "failed"
      ? `INSTALLATION ${record.states.installed.status === "completed" ? "COMPLETED" : record.states.installed.status.toUpperCase()}; CLIENT CONFIGURATION FAILED; MCP PROTOCOL VERIFICATION ${record.states.connection_verified.status === "completed" ? "COMPLETED" : record.states.connection_verified.status.toUpperCase()}; AUTHENTICATION ${record.states.authenticated.status === "not_verified" ? "NOT VERIFIED" : record.states.authenticated.status.toUpperCase()}${retainedInstallation}`
      : record.states.setup_required.status === "setup_required"
        ? "INSTALLATION SUCCEEDED; REQUIRED SETUP IS PENDING"
        : record.states.configured.status === "completed" &&
            record.states.connection_verified.status === "completed"
          ? "INSTALLATION AND CONFIGURATION SUCCEEDED; MCP CONNECTION VERIFIED; AUTHENTICATION NOT VERIFIED"
          : record.states.configured.status === "completed"
            ? "INSTALLATION SUCCEEDED; CLIENT CONFIGURATION VERIFIED; MCP CONNECTION NOT VERIFIED"
            : "INSTALLATION INCOMPLETE";
  return `Installation status\n${rows.join("\n")}\n\nResult: ${result}`;
}
