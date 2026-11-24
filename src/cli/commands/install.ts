import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { discoverByServiceUrl } from "../../discovery/search-service.js";
import { OfficialRegistryAdapter, RegistryError } from "../../discovery/registry/official-registry-adapter.js";
import { getClientAdapter } from "../../installers/adapters.js";
import { createInstallPlan } from "../../installers/plan-installer.js";
import { InstallationStateStore } from "../../installers/state-store.js";
import type { ServerCandidate } from "../../models/server-candidate.js";
import { createInstallationRecord, type InstallationRecord, type InstallationStep } from "../../models/installation.js";
import { verifyHttpMcp, verifyStdioMcp, type McpVerificationResult } from "../../verification/mcp-connection.js";
import { safeTerminalText } from "../output.js";
import { findManagedNpm, installManagedNpm, managedInstallPath, updateManagedMetadata } from "../../installers/managed-npm.js";
import { collectRequiredCredentials, CredentialPromptCancelled } from "../credentials.js";
import type { RegistryInputRequirement } from "../../models/server-candidate.js";
import type { ServerConfiguration } from "../../installers/types.js";

export function registerInstallCommand(program: Command): void {
  const installCommand = program.command("install <server> <client>")
    .description("Install or register an MCP server for one AI client")
    .option("--ephemeral", "Use an ephemeral runtime instead of a persistent managed installation")
    .action(async (server: string, clientId: string) => {
      const stateStore = new InstallationStateStore();
      let record: InstallationRecord | undefined;
      let documentedRequirements: RegistryInputRequirement[] = [];
      let phase: "resolve" | "installation" | "verification" | "configuration" | "complete" = "resolve";
      try {
        const options = installCommand.opts() as { ephemeral?: boolean };
        const adapter = getClientAdapter(clientId);
        const candidate = await resolve(server);
        const sourceOptions = [
          ...(candidate.operational.remoteEndpoints.some((endpoint) => endpoint.startsWith("https://")) ? ["remote"] : []),
          ...candidate.operational.packages.filter((item) => item.identifier && item.registryType).map((item) => `${item.registryType!.toLowerCase()}:${item.identifier}`),
        ];
        const selectedSource = sourceOptions.length > 1 ? await selectOne("Choose installation source:", sourceOptions) : undefined;
        const plan = createInstallPlan(candidate, undefined, selectedSource, options.ephemeral === true);
        if (adapter.id === "claude" && plan.entry.url) throw new Error("Claude remote MCP connectors are managed in Claude settings; MCPGet will not edit an undocumented remote configuration. Add the endpoint in Claude’s custom connectors UI.");
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
        });
        if (plan.strategy === "managed" && plan.packageIdentifier) {
          record.packageIdentifier = plan.packageIdentifier;
          record.installationPath = managedInstallPath(plan.packageIdentifier, plan.packageVersion);
        }
        const current = await readCurrentConfiguration(adapter);
        const priorRecord = await stateStore.get(candidate.registryIdentifier, adapter.id);
        if (plan.strategy === "managed" && plan.packageIdentifier) {
          const existingManaged = await findManagedNpm(plan.packageIdentifier, plan.packageVersion);
          if (existingManaged) {
            plan.entry.command = existingManaged.command;
            plan.entry.args = existingManaged.args;
          }
        }
        const persistedMatchBeforeInstall = await adapter.verify(plan.entry);
        const managedPriorEntry = priorRecord?.configName === plan.entry.name && priorRecord.configPath === adapter.configPath() && priorRecord.configScope === adapter.configScope();
        if (current[plan.entry.name] && !persistedMatchBeforeInstall.verified && !managedPriorEntry) {
          throw new Error(`A different server named ${plan.entry.name} is already configured for ${adapter.displayName}. Remove or rename it first.`);
        }
        await stateStore.put(record);
        console.log(`MCPGet\n\n${plan.method}\nSource: ${safeTerminalText(candidate.sourceRegistry)} · ${safeTerminalText(candidate.sourceRecordUrl, 180)}\nTarget: ${adapter.displayName}\nConfiguration scope: user\nConfiguration: ${safeTerminalText(adapter.configPath())}`);
        if (plan.strategy === "managed") {
          console.log(`Managed installation location: ${safeTerminalText(record.installationPath!)}`);
          console.log(`Action: npm installs ${safeTerminalText(plan.packageIdentifier!)}${plan.packageVersion ? `@${safeTerminalText(plan.packageVersion)}` : " (latest; resolved version will be recorded)"} locally in that directory. npm lifecycle scripts may execute.`);
        }
        if (plan.strategy === "ephemeral") console.log("Explicit ephemeral execution requested; the package may be downloaded at client launch:", `${plan.entry.command} ${(plan.entry.args ?? []).join(" ")}`);
        if (!(await confirm("Continue? [y/N] "))) { console.log("Cancelled; no changes made."); return; }
        phase = "installation";
        record.states.install_confirmed = completed("User approved the proposed server source and target client.");
        await stateStore.put(record);
        if (plan.strategy === "managed" && plan.packageIdentifier) {
          const installed = await installManagedNpm(plan.packageIdentifier, plan.packageVersion);
          record.installationPath = installed.directory;
          record.packageIdentifier = installed.packageIdentifier;
          record.installedVersion = installed.installedVersion;
          documentedRequirements = installed.documentedRequirements ?? [];
          record.states.installed = completed(`${installed.reused ? "Reused" : "Installed"} ${installed.packageIdentifier}@${installed.installedVersion} in MCPGet's managed directory.`);
          plan.entry.command = installed.command;
          plan.entry.args = installed.args;
          await stateStore.put(record);
        }
        const requiredInputs = mergeRequiredInputs(candidate.operational.configurationInputs, documentedRequirements);
        const supportsEnvironment = plan.strategy !== "remote" && !plan.entry.url;
        const existingEnv = supportsEnvironment ? current[plan.entry.name]?.env ?? {} : {};
        if (supportsEnvironment) plan.entry.env = { ...existingEnv };
        const credentialInputs = requiredInputs.filter((input) => !isOAuthInput(input));
        if (credentialInputs.length && supportsEnvironment) {
          console.log(`\nAuthentication configuration required:\n${credentialInputs.map((input) => `  ${safeTerminalText(input.name, 80)}`).join("\n")}`);
          console.log("The client configuration may store environment-variable values in plaintext. MCPGet will not store them in its installation metadata.");
        }
        const credentials = await collectRequiredCredentials(requiredInputs, existingEnv, supportsEnvironment);
        const requiredEnvironmentNames = requiredInputs.filter((input) => !isOAuthInput(input)).map((input) => input.name);
        const suppliedRequiredNames = requiredEnvironmentNames.filter((name) => Object.prototype.hasOwnProperty.call(credentials.values, name));
        const credentialSetupComplete = requiredEnvironmentNames.length > 0 && suppliedRequiredNames.length === requiredEnvironmentNames.length;
        if (supportsEnvironment) {
          plan.entry.env ??= {};
          for (const name of credentials.skipped) delete plan.entry.env[name];
          Object.assign(plan.entry.env, credentials.values);
          if (Object.keys(plan.entry.env).length === 0 && requiredInputs.length === 0 && Object.keys(existingEnv).length === 0) delete plan.entry.env;
        }
        if (credentials.skipped.length) {
          console.log(`Setup remains incomplete; no value was provided for: ${credentials.skipped.map((name) => safeTerminalText(name, 80)).join(", ")}.`);
        }
        if (credentials.unsupported.length) {
          console.log(`Setup remains incomplete; ${adapter.displayName} cannot pass required environment values to this remote endpoint: ${credentials.unsupported.map((name) => safeTerminalText(name, 80)).join(", ")}.`);
        }
        if (credentials.oauth.length) {
          console.log(`OAuth setup required (${credentials.oauth.map((name) => safeTerminalText(name, 80)).join(", ")}); complete the MCP client/server's documented sign-in flow. MCPGet does not collect OAuth tokens.`);
        }
        let verification: McpVerificationResult;
        phase = "verification";
        const setupPending = credentials.skipped.length > 0 || credentials.unsupported.length > 0 || credentials.oauth.length > 0;
        if (credentials.skipped.length || credentials.unsupported.length) {
          verification = { status: "initialization_failed", detail: "Startup and connection verification were deferred because required environment setup is incomplete.", startupVerified: false };
          record.states.startup_verified = plan.entry.url
            ? { status: "not_applicable", detail: "Remote endpoint; no local server process was started." }
            : { status: "not_verified", detail: verification.detail, at: new Date().toISOString() };
          record.states.connection_verified = { status: "not_verified", detail: verification.detail, at: new Date().toISOString() };
        } else if (plan.entry.url) verification = await verifyHttpMcp(plan.entry.url);
        else verification = await verifyStdioMcp(plan.entry.command!, plan.entry.args!, plan.entry.env ? { env: plan.entry.env } : {});
        if (setupPending) {
          record.states.setup_required = {
            status: "setup_required",
            detail: [
              ...(credentials.skipped.length ? [`Missing required environment variables: ${credentials.skipped.join(", ")}.`] : []),
              ...(credentials.unsupported.length ? [`Unsupported remote environment configuration: ${credentials.unsupported.join(", ")}.`] : []),
              ...(credentials.oauth.length ? ["OAuth setup is required through the client/server workflow."] : []),
            ].join(" "),
            at: new Date().toISOString(),
          };
        } else if (verification.status === "authentication_required" && suppliedRequiredNames.length === 0) {
          record.states.setup_required = {
            status: "setup_required",
            detail: "Authentication is required, but MCPGet could not identify a specific credential or OAuth flow.",
            at: new Date().toISOString(),
          };
        } else if (credentialSetupComplete) {
          record.states.setup_required = { status: "not_verified", detail: "Required environment values were collected; client configuration verification is pending.", at: new Date().toISOString() };
        } else {
          record.states.setup_required = { status: "not_applicable", detail: "No documented authentication or credential setup was identified.", at: new Date().toISOString() };
        }
        if (plan.entry.url) record.states.startup_verified = { status: "not_applicable", detail: "Remote endpoint; no local server process was started." };
        if (credentials.skipped.length || credentials.unsupported.length) {
          record.states.authenticated = { status: "not_verified", detail: "Authentication was not independently verified.", at: new Date().toISOString() };
        } else if (verification.status === "authentication_required") {
          record.states.startup_verified = plan.entry.url
            ? { status: "not_applicable", detail: "Remote endpoint; no local server process was started." }
            : verification.startupVerified
              ? completed("The server process started; authentication is required before MCP initialization.")
              : { status: "failed", detail: verification.detail, at: new Date().toISOString() };
          record.states.authenticated = { status: "authentication_required", detail: verification.detail, at: new Date().toISOString() };
          record.states.connection_verified = { status: "authentication_required", detail: "MCP initialization requires authentication.", at: new Date().toISOString() };
        } else if (verification.status === "connection_verified") {
          record.states.startup_verified = plan.entry.url
            ? { status: "not_applicable", detail: "Remote endpoint; no local server process was started." }
            : verification.startupVerified
              ? completed("Server process started and responded to the bounded verification check.")
              : { status: "failed", detail: "The server process did not start.", at: new Date().toISOString() };
          record.states.connection_verified = completed(`${verification.detail}${verification.protocolVersion ? ` Protocol ${verification.protocolVersion}.` : ""}`);
          record.states.authenticated = { status: "not_verified", detail: suppliedRequiredNames.length
            ? `Required environment configuration was supplied for ${suppliedRequiredNames.join(", ")}; MCP initialization does not independently verify authentication.`
            : "No independent authentication state was reported by the MCP initialize handshake.", at: new Date().toISOString() };
        } else {
          record.states.startup_verified = plan.entry.url
            ? { status: "not_applicable", detail: "Remote endpoint; no local server process was started." }
            : !verification.startupVerified
              ? { status: "failed", detail: verification.detail, at: new Date().toISOString() }
              : completed("The server process started; protocol initialization did not complete.");
          record.states.connection_verified = { status: "failed", detail: verification.detail, at: new Date().toISOString() };
        }
        phase = "configuration";
        const persistedMatchWithCredentials = await adapter.verify(plan.entry);
        if (!persistedMatchWithCredentials.verified) await adapter.add(plan.entry);
        const verificationResult = await adapter.verify(plan.entry);
        if (!verificationResult.verified) {
          if (!current[plan.entry.name]) await adapter.remove(plan.entry.name).catch(() => false);
          record.states.configured = { status: "failed", detail: verificationResult.detail, at: new Date().toISOString() };
          record.lastError = record.states.configured.detail;
          await stateStore.put(record);
          throw new Error(`${adapter.displayName} configuration verification failed; MCPGet attempted to roll back the registration. ${verificationResult.detail}`);
        }
        record.states.configured = completed(verificationResult.detail);
        if (credentialSetupComplete) {
          record.states.setup_required = completed(`Required environment configuration independently verified for: ${suppliedRequiredNames.join(", ")}.`);
        }
        phase = "complete";
        if (record.strategy === "ephemeral") record.states.execution_registered = completed("Ephemeral command recorded in the selected client; no persistent package installation was performed.");
        if (record.strategy === "managed" && record.installationPath) {
          await updateManagedMetadata({ directory: record.installationPath, packageIdentifier: record.packageIdentifier!, installedVersion: record.installedVersion!, command: plan.entry.command!, args: plan.entry.args ?? [], reused: false }, {
            serverIdentifier: record.serverIdentifier, serverName: record.displayName, client: adapter.id,
            configurationEntry: record.configName, verificationStatus: record.states.connection_verified.status,
            ...(record.states.connection_verified.status === "completed" ? { lastVerifiedAt: record.states.connection_verified.at } : {}),
          });
        }
        if (record.states.authenticated.status === "authentication_required" && adapter.authenticate) {
          if (await confirm("Codex reports authentication is required. Run Codex's own OAuth login now? [y/N] ")) {
            try {
              await adapter.authenticate(plan.entry.name);
              record.states.authenticated = { status: "not_verified", detail: "Codex reported that its OAuth login flow completed; authentication with the MCP server was not independently verified.", at: new Date().toISOString() };
              record.states.setup_required = { status: "not_verified", detail: "Codex reported OAuth login completion; MCPGet has not independently confirmed authentication with the server.", at: new Date().toISOString() };
              record.states.connection_verified = { status: "not_verified", detail: "Authentication completed in Codex; MCP connection could not be independently verified by MCPGet.", at: new Date().toISOString() };
            } catch {
              record.states.authenticated = { status: "failed", detail: "Codex OAuth login did not complete. Retry with `codex mcp login`.", at: new Date().toISOString() };
            }
          }
        } else if (record.states.authenticated.status === "authentication_required" && adapter.id === "cursor") {
          record.states.authenticated.detail = "Complete Cursor's client-managed OAuth sign-in after opening Cursor. MCPGet cannot inspect Cursor's stored credentials or confirm later sign-in.";
        }
        await stateStore.put(record);
        console.log(`\n${reportStates(record)}`);
      } catch (error) {
        if (error instanceof CredentialPromptCancelled) {
          if (record) {
            record.states.setup_required = { status: "setup_required", detail: "Credential entry was cancelled. The persistent installation was retained; client configuration was not changed.", at: new Date().toISOString() };
            await stateStore.put(record);
            console.log(reportStates(record));
          }
          console.log("Credential entry cancelled; the installation remains available and no client configuration was changed.");
          return;
        }
        const message = error instanceof RegistryError ? error.message : error instanceof Error ? error.message : "Installation failed.";
        if (record) {
          record.lastError = message;
          if (record.states.install_confirmed.status === "completed") {
            if (phase === "installation" && record.strategy === "managed" && record.states.installed.status !== "completed") {
              record.states.installed = { status: "failed", detail: message, at: new Date().toISOString() };
            } else if (phase === "verification" && record.states.connection_verified.status !== "failed") {
              record.states.connection_verified = { status: "failed", detail: "MCP verification did not complete.", at: new Date().toISOString() };
            } else if (phase === "configuration" && record.states.configured.status !== "completed") {
              record.states.configured = { status: "failed", detail: message, at: new Date().toISOString() };
            }
          }
          await stateStore.put(record).catch(() => undefined);
          console.error(reportStates(record));
        }
        console.error(`${phase === "configuration" ? "Configuration failed" : "Install failed"}: ${safeTerminalText(message)}`);
        process.exitCode = 1;
      }
    });
}

async function resolve(input: string): Promise<ServerCandidate> {
  const registry = new OfficialRegistryAdapter();
  if (/^https:\/\//i.test(input)) {
    const url = new URL(input);
    if (url.username || url.password) throw new Error("Remote endpoint URLs cannot contain embedded credentials.");
    if ([...url.searchParams.keys()].some((key) => /token|secret|key|auth|password|credential|session|cookie|signature|bearer/i.test(key))) {
      throw new Error("Remote endpoint URLs with credential-like query parameters are not accepted. Configure authentication through the MCP client instead.");
    }
    url.hash = "";
    return {
      name: url.hostname, title: url.hostname, registryIdentifier: url.toString(),
      operational: { deploymentModels: ["Remote endpoint"], transports: ["streamable-http"], packages: [], remoteEndpoints: [url.toString()], configurationInputs: [], authentication: "Unknown", clientCompatibility: "Unknown", setupComplexity: "Unknown" },
      sourceRegistry: "User supplied", sourceRecordUrl: "Explicit user-supplied endpoint",
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
    if (!identifier || /[\s;&|<>]/.test(identifier)) throw new Error("Package reference is invalid.");
    return {
      name: identifier, registryIdentifier: input,
      operational: { deploymentModels: ["Local package"], transports: ["stdio"], packages: [{ ...(registryType ? { registryType } : {}), identifier, ...(version ? { version } : {}) }], remoteEndpoints: [], configurationInputs: [], authentication: "Unknown", clientCompatibility: "Unknown", setupComplexity: "Unknown" },
      sourceRegistry: "User supplied", sourceRecordUrl: "Explicit user-supplied package reference",
    };
  }
  if (input.includes("/") && !input.includes("\\")) return registry.getByIdentifier(input);
  const result = await discoverByServiceUrl(input, registry);
  if (result.evaluations.length === 0) throw new Error("No matching Registry candidates were found. Try an exact Registry identifier or package reference.");
  const installable = result.evaluations.filter((item) => item.candidate.operational.packages.length || item.candidate.operational.remoteEndpoints.some((endpoint) => endpoint.startsWith("https://")));
  if (installable.length === 0) throw new Error("No candidate declares a supported installation source.");
  if (installable.length > 1) {
    const choices = installable.slice(0, 8).map((item) => `${item.candidate.registryIdentifier} — ${item.candidate.title ?? item.candidate.name}`);
    const answer = await selectOne("Several installable candidates match. Choose one:", choices);
    return installable[choices.indexOf(answer)]!.candidate;
  }
  return installable[0]!.candidate;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive confirmation is required. Run this command in a terminal; no changes were made.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); process.stdin.pause(); }
}
async function selectOne(question: string, choices: string[]): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`Interactive selection is required. Run this command in a terminal. Options: ${choices.join("; ")}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    choices.forEach((choice, index) => console.log(`  ${index + 1}. ${safeTerminalText(choice, 130)}`));
    const answer = await rl.question(`${question} Enter a number: `);
    const index = Number(answer.trim()) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= choices.length) throw new Error("Invalid selection; no changes were made.");
    return choices[index]!;
  } finally { rl.close(); process.stdin.pause(); }
}
function completed(detail: string): InstallationStep {
  return { status: "completed", detail, at: new Date().toISOString() };
}

async function readCurrentConfiguration(adapter: ReturnType<typeof getClientAdapter>): Promise<Record<string, ServerConfiguration>> {
  try { return await adapter.read(); }
  catch (error) {
    if (adapter.id === "codex" && error instanceof Error && /user-scope configuration is missing/i.test(error.message)) return {};
    throw error;
  }
}

export function mergeRequiredInputs(registryInputs: RegistryInputRequirement[], documentedInputs: RegistryInputRequirement[]): RegistryInputRequirement[] {
  const inputs = new Map<string, RegistryInputRequirement>();
  for (const input of [...registryInputs, ...documentedInputs]) {
    if (input.required !== true) continue;
    const prior = inputs.get(input.name);
    const description = input.description ?? prior?.description;
    inputs.set(input.name, {
      ...prior,
      ...input,
      required: true,
      secret: input.secret === true || prior?.secret === true,
      ...(description !== undefined ? { description } : {}),
    });
  }
  return [...inputs.values()].slice(0, 12);
}

function isOAuthInput(input: RegistryInputRequirement): boolean {
  return /oauth/i.test(`${input.name} ${input.description ?? ""}`);
}

export function reportStates(record: InstallationRecord): string {
  const rows = Object.entries(record.states).map(([name, step]) => `- [${step.status.toUpperCase()}] ${name}: ${safeTerminalText(step.detail, 220)}`);
  const retainedInstallation = record.strategy === "managed" && record.states.installed.status === "completed"
    ? "; PERSISTENT INSTALLATION IS RETAINED"
    : "";
  const result = record.states.configured.status === "failed"
    ? `INSTALLATION ${record.states.installed.status === "completed" ? "COMPLETED" : record.states.installed.status.toUpperCase()}; CLIENT CONFIGURATION FAILED; MCP PROTOCOL VERIFICATION ${record.states.connection_verified.status === "completed" ? "COMPLETED" : record.states.connection_verified.status.toUpperCase()}; AUTHENTICATION ${record.states.authenticated.status === "not_verified" ? "NOT VERIFIED" : record.states.authenticated.status.toUpperCase()}${retainedInstallation}`
    : record.states.setup_required.status === "setup_required"
      ? "INSTALLATION SUCCEEDED; REQUIRED SETUP IS PENDING"
    : record.states.configured.status === "completed" && record.states.connection_verified.status === "completed"
      ? "INSTALLATION AND CONFIGURATION SUCCEEDED; MCP CONNECTION VERIFIED; AUTHENTICATION NOT VERIFIED"
    : record.states.configured.status === "completed"
      ? "INSTALLATION SUCCEEDED; CLIENT CONFIGURATION VERIFIED; MCP CONNECTION NOT VERIFIED"
      : "INSTALLATION INCOMPLETE";
  return `Installation status\n${rows.join("\n")}\n\nResult: ${result}`;
}

