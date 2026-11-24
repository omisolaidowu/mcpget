import type { Command } from "commander";
import { getClientAdapters, getClientAdapter } from "../../installers/adapters.js";
import type { ClientAdapter } from "../../installers/types.js";
import { InstallationStateStore } from "../../installers/state-store.js";
import { safeTerminalText } from "../output.js";
import { releaseManagedAssociation } from "../../installers/managed-npm.js";

export function registerManagementCommands(program: Command): void {
  program.command("clients").description("Show supported MCP clients and configuration status").action(async () => {
    for (const adapter of getClientAdapters()) {
      let configured = false;
      try { configured = await adapter.detect(); } catch { /* report unavailable */ }
      const status = adapter.id === "codex"
        ? configured ? "User configuration present" : "User configuration not found; app presence is unknown"
        : configured ? "MCP configuration present" : "MCP configuration not found; app presence is unknown";
      console.log(`${adapter.id}\t${status}\t${adapter.displayName}`);
    }
    console.log("Claude remote connectors are managed in Claude settings; Codex user configuration is managed directly.");
  });

  const list = program.command("list [client]").description("List MCP servers configured for supported clients");
  list.action(async (clientId?: string) => {
    try {
      const adapters = clientId ? [getClientAdapter(clientId)] : getClientAdapters();
      const records = await new InstallationStateStore().all().catch(() => []);
      let count = 0;
      for (const adapter of adapters) {
        for (const [name, value] of Object.entries(await adapter.read())) {
          count += 1;
          const record = records.find((item) => item.client === adapter.id && item.configName === name);
      const status = record?.states.connection_verified.status === "completed"
            ? "MCP protocol initialized by MCPGet; client runtime not verified"
        : record?.states.installed.status === "completed"
            ? "Managed package installed; connection not verified"
            : record?.states.authenticated.status === "authentication_required"
              ? "Authentication required"
              : record?.lastError ? "Setup/verification failed" : "Configured; connection unknown";
          console.log(`${safeTerminalText(name)}\t${adapter.id}\t${status}\t${safeTerminalText(value.command ?? value.url ?? "configuration present")}`);
        }
      }
      if (!count) console.log("No configured MCP servers found.");
    } catch (error) {
      console.error(`List failed: ${error instanceof Error ? safeTerminalText(error.message) : "client configuration could not be read"}`);
      process.exitCode = 1;
    }
  });

  const remove = program.command("remove <server> <client>").description("Remove an MCP server entry from one client");
  remove.action(async (name: string, clientId: string) => {
    const adapter = getClientAdapter(clientId);
    const servers = await adapter.read();
    const store = new InstallationStateStore();
    const records = await store.all();
    const record = records.find((item) => item.client === adapter.id && (item.id === name || item.serverIdentifier === name || item.configName === name));
    const configName = record?.configName ?? name;
    if (!(configName in servers)) { console.error(`No server named ${safeTerminalText(name)} is configured for ${adapter.displayName}.`); process.exitCode = 1; return; }
    if (!await confirm("Remove this configuration entry? [y/N] ")) { console.log("Cancelled; no changes made."); return; }
    if (await adapter.remove(configName)) {
      if (!(await adapter.verifyRemoved(configName))) throw new Error(`${adapter.displayName} still reports ${configName} after the removal command.`);
      if (record) await store.delete(record.id, adapter.id);
      if (record?.strategy === "managed" && record.installationPath) {
        const removedFiles = await releaseManagedAssociation(record.installationPath, record.serverIdentifier, adapter.id, configName).catch(() => false);
        console.log(removedFiles ? "Removed the unused MCPGet-managed package." : "Kept the managed package because another client/server still references it.");
      }
      console.log(`Removed ${safeTerminalText(configName)} from ${adapter.displayName}.`);
    }
  });

  const doctor = program.command("doctor [client]").description("Check client configuration and runtime availability");
  doctor.action(async (clientId?: string) => {
    const adapters = clientId ? [getClientAdapter(clientId)] : getClientAdapters();
    for (const adapter of adapters) await diagnose(adapter);
  });
}

async function diagnose(adapter: ClientAdapter): Promise<void> {
  try {
    const servers = await adapter.read();
    console.log(`${adapter.displayName}: configuration readable (${Object.keys(servers).length} MCP entries) at ${safeTerminalText(adapter.configPath())}`);
    const records = await new InstallationStateStore().all().catch(() => []);
    for (const [name, entry] of Object.entries(servers)) {
      const record = records.find((item) => item.client === adapter.id && item.configName === name);
      console.log(`  ${safeTerminalText(name)}: ${record?.states.connection_verified.status === "completed" ? "MCP protocol initialized by MCPGet; client runtime not verified" : record?.states.authenticated.status === "authentication_required" ? "authentication required" : "configuration present; connection not verified"}`);
      if (entry.command) console.log(`    Runtime executable: ${await executableExists(entry.command) ? "available" : "not found"}`);
    }
    if (adapter.id === "codex") console.log(`Codex CLI for optional OAuth login: ${await executableExists("codex") ? "available" : "not found"}`);
  } catch (error) {
    console.log(`${adapter.displayName}: ${error instanceof Error ? safeTerminalText(error.message) : "configuration unavailable"}`);
  }
}

async function executableExists(command: string): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  const { delimiter, isAbsolute, join } = await import("node:path");
  const { platform } = await import("node:os");
  const extensions = platform() === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const candidates = isAbsolute(command)
    ? [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)]
    : (process.env.PATH ?? "").split(delimiter).flatMap((directory) => extensions.map((extension) => join(directory, `${command}${extension.toLowerCase()}`)));
  for (const candidate of candidates) {
    try { await access(candidate); return true; } catch { /* continue PATH search */ }
  }
  return false;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive confirmation is required; no changes were made.");
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
}
