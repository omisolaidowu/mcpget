import { homedir } from "node:os";
import { readdirSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readJsonObject, writeJsonSafely } from "./atomic-config.js";
import type { ClientAdapter, ClientId, ServerConfiguration } from "./types.js";

export class JsonClientAdapter implements ClientAdapter {
  constructor(
    readonly id: Extract<ClientId, "claude" | "cursor">,
    readonly displayName: string,
    private readonly path: string,
  ) {}
  configPath(): string { return this.path; }
  configScope(): "user" { return "user"; }
  async detect(): Promise<boolean> {
    const { access } = await import("node:fs/promises");
    try { await access(this.path); return true; } catch { return false; }
  }
  async read(): Promise<Record<string, ServerConfiguration>> {
    const root = await readJsonObject(this.path);
    const servers = root.mcpServers;
    if (servers === undefined) return {};
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) throw new Error(`${this.displayName} configuration has an invalid mcpServers field.`);
    for (const [name, server] of Object.entries(servers)) {
      if (typeof server !== "object" || server === null || Array.isArray(server)) throw new Error(`${this.displayName} entry ${name} is not an object.`);
      const entry = server as Record<string, unknown>;
      if (entry.command !== undefined && typeof entry.command !== "string") throw new Error(`${this.displayName} entry ${name} has an invalid command.`);
      if (entry.url !== undefined && typeof entry.url !== "string") throw new Error(`${this.displayName} entry ${name} has an invalid URL.`);
      if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((item) => typeof item !== "string"))) throw new Error(`${this.displayName} entry ${name} has invalid arguments.`);
      if (entry.env !== undefined && (typeof entry.env !== "object" || entry.env === null || Array.isArray(entry.env) || Object.values(entry.env).some((value) => typeof value !== "string"))) throw new Error(`${this.displayName} entry ${name} has invalid environment variables.`);
      if (typeof entry.command !== "string" && typeof entry.url !== "string") throw new Error(`${this.displayName} entry ${name} must declare a command or URL.`);
    }
    return servers as Record<string, ServerConfiguration>;
  }
  async add(entry: ServerConfiguration): Promise<void> {
    const root = await readJsonObject(this.path);
    const servers = root.mcpServers;
    if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) throw new Error(`${this.displayName} configuration has an invalid mcpServers field.`);
    const current = (servers ?? {}) as Record<string, unknown>;
    const clientEntry = this.toClientEntry(entry);
    if (matchesExpected(current[entry.name], clientEntry)) return;
    let prior: Buffer | undefined;
    try { prior = await import("node:fs/promises").then(({ readFile }) => readFile(this.path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try {
      const merged = mergeEntry(current[entry.name], clientEntry);
      await writeJsonSafely(this.path, { ...root, mcpServers: { ...current, [entry.name]: merged } });
      const result = await this.verify(entry);
      if (!result.verified) throw new Error(result.detail);
    } catch (error) {
      const { unlink, writeFile } = await import("node:fs/promises");
      if (prior) await writeFile(this.path, prior);
      else await unlink(this.path).catch(() => undefined);
      throw new Error(`${this.displayName} configuration update failed and was rolled back: ${error instanceof Error ? error.message : "persisted entry could not be verified"}`);
    }
  }
  async verify(entry: ServerConfiguration): Promise<{ verified: boolean; detail: string }> {
    try {
      await import("node:fs/promises").then(({ access }) => access(this.path));
      const root = await readJsonObject(this.path);
      const servers = root.mcpServers;
      if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return { verified: false, detail: `${this.displayName} configuration has no valid mcpServers object at ${this.path}.` };
      const actual = (servers as Record<string, unknown>)[entry.name];
      if (!matchesExpected(actual, this.toClientEntry(entry))) return { verified: false, detail: `${this.displayName} persisted entry ${entry.name} does not match the requested command, arguments, environment, or endpoint at ${this.path}.` };
      return { verified: true, detail: `Exact server entry re-read from ${this.path} in user scope.` };
    } catch (error) {
      return { verified: false, detail: error instanceof Error ? error.message : `${this.displayName} configuration could not be independently re-read.` };
    }
  }
  async verifyRemoved(name: string): Promise<boolean> {
    try {
      await import("node:fs/promises").then(({ access }) => access(this.path));
      return !(name in await this.read());
    } catch { return false; }
  }
  async remove(name: string): Promise<boolean> {
    const root = await readJsonObject(this.path);
    if (typeof root.mcpServers !== "object" || root.mcpServers === null || Array.isArray(root.mcpServers)) return false;
    const servers = { ...(root.mcpServers as Record<string, unknown>) };
    if (!(name in servers)) return false;
    let prior: Buffer | undefined;
    try { prior = await import("node:fs/promises").then(({ readFile }) => readFile(this.path)); } catch { /* The validated read above established the target. */ }
    delete servers[name];
    try {
      await writeJsonSafely(this.path, { ...root, mcpServers: servers });
      if (!(await this.verifyRemoved(name))) throw new Error(`${this.displayName} still lists ${name} after removal.`);
    } catch (error) {
      const { writeFile } = await import("node:fs/promises");
      if (prior) await writeFile(this.path, prior);
      throw new Error(`${this.displayName} removal failed and was rolled back: ${error instanceof Error ? error.message : "persisted removal could not be verified"}`);
    }
    return true;
  }
  private toClientEntry(entry: ServerConfiguration): Record<string, unknown> {
    const config = { ...entry } as Record<string, unknown>;
    delete config.name;
    delete config.transport;
    if (this.id === "cursor" && !entry.url) config.type = "stdio";
    return config;
  }
}

function matchesExpected(actual: unknown, expected: Record<string, unknown>): boolean {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => {
    const observed = (actual as Record<string, unknown>)[key];
    if (key === "env") return isDeepStrictEqual(observed, value);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return matchesExpected(observed, value as Record<string, unknown>);
    return isDeepStrictEqual(observed, value);
  });
}

function mergeEntry(existing: unknown, expected: Record<string, unknown>): Record<string, unknown> {
  const prior = typeof existing === "object" && existing !== null && !Array.isArray(existing) ? existing as Record<string, unknown> : {};
  const preserved = { ...prior };
  for (const key of ["command", "args", "url", "type", "transport"]) delete preserved[key];
  const merged: Record<string, unknown> = { ...preserved, ...expected };
  return merged;
}

export interface JsonClientPathOptions { platform?: NodeJS.Platform; home?: string; appData?: string; localAppData?: string; xdgConfigHome?: string; claudeProfiles?: string[]; claudeConfigPath?: string }
export function resolveClaudeConfigPath(options: JsonClientPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const joinPath = platform === "win32" ? path.win32.join : path.posix.join;
  if (platform === "win32") {
    const explicitPath = options.claudeConfigPath ?? process.env.MCPGET_CLAUDE_CONFIG_PATH;
    if (explicitPath) return explicitPath;
    const localAppData = options.localAppData ?? process.env.LOCALAPPDATA ?? joinPath(home, "AppData", "Local");
    const profileRoot = joinPath(localAppData, "Claude-Data");
    const profiles = options.claudeProfiles ?? (() => { try { return readdirSync(profileRoot, { withFileTypes: true }).filter((item) => item.isDirectory() && item.name.startsWith("claude_")).map((item) => item.name); } catch { return []; } })();
    if (profiles.length > 1) throw new Error(`Multiple Claude Desktop data profiles exist under ${profileRoot}; set MCPGET_CLAUDE_CONFIG_PATH to the active profile configuration.`);
    if (profiles.length === 1) return joinPath(profileRoot, profiles[0]!, "claude_desktop_config.json");
    const appData = options.appData ?? process.env.APPDATA ?? joinPath(home, "AppData", "Roaming");
    return joinPath(appData, "Claude", "claude_desktop_config.json");
  }
  if (platform === "darwin") return joinPath(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return joinPath(options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? joinPath(home, ".config"), "Claude", "claude_desktop_config.json");
}
export function resolveCursorConfigPath(options: Pick<JsonClientPathOptions, "home" | "platform"> = {}): string {
  const joinPath = options.platform === "win32" ? path.win32.join : options.platform ? path.posix.join : path.join;
  return joinPath(options.home ?? homedir(), ".cursor", "mcp.json");
}

export function createJsonClientAdapters(options: JsonClientPathOptions = {}): JsonClientAdapter[] {
  const claudePath = resolveClaudeConfigPath(options);
  const cursorPath = resolveCursorConfigPath(options);
  return [
    new JsonClientAdapter("claude", "Claude Desktop (local stdio configuration)", claudePath),
    new JsonClientAdapter("cursor", "Cursor", cursorPath),
  ];
}
