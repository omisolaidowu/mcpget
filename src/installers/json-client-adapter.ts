import { homedir } from "node:os";
import { readdirSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  readJsonObject,
  readJsonSnapshot,
  writeJsonSafely,
  type JsonWriteReceipt,
} from "./atomic-config.js";
import {
  assertNoConfigBackupArtifacts,
  removeConfigBackup,
  recordConfigBackupOutcome,
  restoreConfigFile,
} from "./config-backup.js";
import {
  ensureConfigBackupLifecycle,
  validateBackupClientConfiguration,
} from "./config-backup-lifecycle.js";
import { withFileLock } from "./file-lock.js";
import { OperationJournal } from "./operation-journal.js";
import {
  normalizeServerRegistration,
  type ClientAdapter,
  type ClientId,
  type ExistingServerRegistration,
  type ServerConfiguration,
} from "./types.js";

export class JsonClientAdapter implements ClientAdapter {
  constructor(
    readonly id: Extract<
      ClientId,
      "claude" | "cursor" | "copilot-vscode" | "copilot-cli"
    >,
    readonly displayName: string,
    private readonly path: string,
    private readonly journal = new OperationJournal(),
    private readonly scope: "user" | "project" = "user",
    private readonly projectFormat:
      "mcpServers" | "bare" | "auto" = "mcpServers",
  ) {}
  configPath(): string {
    return this.path;
  }
  configScope(): "user" | "project" {
    return this.scope;
  }
  async detect(): Promise<boolean> {
    const { access } = await import("node:fs/promises");
    try {
      await access(this.path);
      return true;
    } catch {
      return false;
    }
  }
  async read(): Promise<Record<string, ServerConfiguration>> {
    const root = await readJsonObject(this.path);
    const servers = this.readServerObject(root);
    if (servers === undefined) return {};
    if (
      typeof servers !== "object" ||
      servers === null ||
      Array.isArray(servers)
    )
      throw new Error(
        `${this.displayName} configuration has an invalid MCP server configuration.`,
      );
    for (const [name, server] of Object.entries(servers)) {
      if (
        typeof server !== "object" ||
        server === null ||
        Array.isArray(server)
      )
        throw new Error(`${this.displayName} entry ${name} is not an object.`);
      const entry = server as Record<string, unknown>;
      if (entry.command !== undefined && typeof entry.command !== "string")
        throw new Error(
          `${this.displayName} entry ${name} has an invalid command.`,
        );
      if (entry.url !== undefined && typeof entry.url !== "string")
        throw new Error(
          `${this.displayName} entry ${name} has an invalid URL.`,
        );
      if (
        entry.args !== undefined &&
        (!Array.isArray(entry.args) ||
          entry.args.some((item) => typeof item !== "string"))
      )
        throw new Error(
          `${this.displayName} entry ${name} has invalid arguments.`,
        );
      if (
        entry.env !== undefined &&
        (typeof entry.env !== "object" ||
          entry.env === null ||
          Array.isArray(entry.env) ||
          Object.values(entry.env).some((value) => typeof value !== "string"))
      )
        throw new Error(
          `${this.displayName} entry ${name} has invalid environment variables.`,
        );
      if (typeof entry.command !== "string" && typeof entry.url !== "string")
        throw new Error(
          `${this.displayName} entry ${name} must declare a command or URL.`,
        );
    }
    return servers as Record<string, ServerConfiguration>;
  }
  private readServerObject(
    root: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (root.mcpServers !== undefined) {
      if (
        typeof root.mcpServers !== "object" ||
        root.mcpServers === null ||
        Array.isArray(root.mcpServers)
      )
        throw new Error(
          `${this.displayName} configuration has an invalid mcpServers field.`,
        );
      return root.mcpServers as Record<string, unknown>;
    }
    if (
      this.projectFormat === "bare" ||
      (this.projectFormat === "auto" && this.scope === "project")
    ) {
      return Object.fromEntries(
        Object.entries(root).filter(
          ([, value]) =>
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            (typeof (value as Record<string, unknown>).command === "string" ||
              typeof (value as Record<string, unknown>).url === "string"),
        ),
      );
    }
    return {};
  }
  async readRegistrations(): Promise<ExistingServerRegistration[]> {
    const servers = await this.read();
    return Object.entries(servers).map(([name, entry]) =>
      normalizeServerRegistration(this.id, this.path, this.configScope(), {
        ...entry,
        name,
      }),
    );
  }
  async add(entry: ServerConfiguration, operationId?: string): Promise<void> {
    await withFileLock(this.path, () => this.addUnlocked(entry, operationId));
  }
  private async addUnlocked(
    entry: ServerConfiguration,
    operationId?: string,
  ): Promise<void> {
    await ensureConfigBackupLifecycle(
      this.path,
      this.id,
      (configPath) =>
        validateBackupClientConfiguration(
          this.id,
          this.displayName,
          configPath,
        ),
      this.journal,
      operationId,
    );
    await assertNoConfigBackupArtifacts(this.path);
    const snapshot = await readJsonSnapshot(this.path);
    const root = snapshot.value;
    const servers = this.readServerObject(root);
    if (
      servers !== undefined &&
      (typeof servers !== "object" ||
        servers === null ||
        Array.isArray(servers))
    )
      throw new Error(
        `${this.displayName} configuration has an invalid mcpServers field.`,
      );
    const current = (servers ?? {}) as Record<string, unknown>;
    const clientEntry = this.toClientEntry(entry);
    if (matchesExpected(current[entry.name], clientEntry)) {
      const result = await this.verify(entry);
      if (!result.verified) throw new Error(result.detail);
      return;
    }
    let receipt: JsonWriteReceipt | undefined;
    try {
      const merged = mergeEntry(current[entry.name], clientEntry, this.id);
      const nextRoot =
        root.mcpServers !== undefined ||
        this.projectFormat === "mcpServers" ||
        this.scope === "user"
          ? {
              ...root,
              mcpServers: { ...current, [entry.name]: merged },
            }
          : { ...root, [entry.name]: merged };
      receipt = await writeJsonSafely(this.path, nextRoot, {
        ...(operationId ? { operationId } : {}),
        operationKind: "install",
        deferCommitConfirmation: true,
      });
      const result = await this.verify(entry);
      if (!result.verified) throw new Error(result.detail);
      if (receipt.previousContents)
        await recordConfigBackupOutcome(
          this.path,
          receipt.previousContents,
          "commit_confirmed",
        );
    } catch (error) {
      if (!receipt) throw error;
      try {
        await restoreSnapshot(this.path, receipt.previousContents);
      } catch (rollbackError) {
        if (receipt.previousContents)
          await recordConfigBackupOutcome(
            this.path,
            receipt.previousContents,
            "rollback_failed",
          ).catch(() => undefined);
        throw new Error(
          `${this.displayName} configuration update failed and rollback could not be confirmed; recovery backup retained at ${this.path}.mcpget.bak.`,
          { cause: rollbackError },
        );
      }
      if (receipt.previousContents) {
        try {
          await recordConfigBackupOutcome(
            this.path,
            receipt.previousContents,
            "rollback_confirmed",
          );
          await removeConfigBackup(this.path, receipt.previousContents);
        } catch (cleanupError) {
          throw new Error(
            `${this.displayName} configuration update was rolled back, but backup cleanup could not be completed; the backup was retained.`,
            { cause: cleanupError },
          );
        }
      }
      throw new Error(
        `${this.displayName} configuration update failed and was rolled back: ${error instanceof Error ? error.message : "persisted entry could not be verified"}`,
      );
    }
    if (receipt.previousContents)
      await removeConfigBackup(this.path, receipt.previousContents);
  }
  async verify(
    entry: ServerConfiguration,
  ): Promise<{ verified: boolean; detail: string }> {
    try {
      await import("node:fs/promises").then(({ access }) => access(this.path));
      const root = await readJsonObject(this.path);
      const servers = this.readServerObject(root);
      if (
        typeof servers !== "object" ||
        servers === null ||
        Array.isArray(servers)
      )
        return {
          verified: false,
          detail: `${this.displayName} configuration has no valid mcpServers object at ${this.path}.`,
        };
      const actual = (servers as Record<string, unknown>)[entry.name];
      if (!matchesExpected(actual, this.toClientEntry(entry)))
        return {
          verified: false,
          detail: `${this.displayName} persisted entry ${entry.name} does not match the requested command, arguments, environment, or endpoint at ${this.path}.`,
        };
      return {
        verified: true,
        detail: `Exact server entry re-read from ${this.path} in user scope.`,
      };
    } catch (error) {
      return {
        verified: false,
        detail:
          error instanceof Error
            ? error.message
            : `${this.displayName} configuration could not be independently re-read.`,
      };
    }
  }
  async verifyRemoved(name: string): Promise<boolean> {
    try {
      await import("node:fs/promises").then(({ access }) => access(this.path));
      return !(name in (await this.read()));
    } catch {
      return false;
    }
  }
  async remove(name: string, operationId?: string): Promise<boolean> {
    return withFileLock(this.path, () =>
      this.removeUnlocked(name, operationId),
    );
  }
  private async removeUnlocked(
    name: string,
    operationId?: string,
  ): Promise<boolean> {
    await ensureConfigBackupLifecycle(
      this.path,
      this.id,
      (configPath) =>
        validateBackupClientConfiguration(
          this.id,
          this.displayName,
          configPath,
        ),
      this.journal,
      operationId,
    );
    await assertNoConfigBackupArtifacts(this.path);
    const snapshot = await readJsonSnapshot(this.path);
    const root = snapshot.value;
    const found = this.readServerObject(root);
    if (!found) return false;
    const servers = { ...found };
    if (!(name in servers)) return false;
    delete servers[name];
    let receipt: JsonWriteReceipt | undefined;
    try {
      const nextRoot =
        root.mcpServers !== undefined ||
        this.projectFormat === "mcpServers" ||
        this.scope === "user"
          ? { ...root, mcpServers: servers }
          : { ...root };
      if (
        root.mcpServers === undefined &&
        this.projectFormat !== "mcpServers" &&
        this.scope === "project"
      )
        delete (nextRoot as Record<string, unknown>)[name];
      receipt = await writeJsonSafely(this.path, nextRoot, {
        ...(operationId ? { operationId } : {}),
        operationKind: "remove",
        deferCommitConfirmation: true,
      });
      if (!(await this.verifyRemoved(name)))
        throw new Error(
          `${this.displayName} still lists ${name} after removal.`,
        );
      if (receipt.previousContents)
        await recordConfigBackupOutcome(
          this.path,
          receipt.previousContents,
          "commit_confirmed",
        );
    } catch (error) {
      if (!receipt) throw error;
      try {
        await restoreSnapshot(this.path, receipt.previousContents);
      } catch (rollbackError) {
        if (receipt.previousContents)
          await recordConfigBackupOutcome(
            this.path,
            receipt.previousContents,
            "rollback_failed",
          ).catch(() => undefined);
        throw new Error(
          `${this.displayName} configuration removal failed and rollback could not be confirmed; recovery backup retained at ${this.path}.mcpget.bak.`,
          { cause: rollbackError },
        );
      }
      if (receipt.previousContents) {
        try {
          await recordConfigBackupOutcome(
            this.path,
            receipt.previousContents,
            "rollback_confirmed",
          );
          await removeConfigBackup(this.path, receipt.previousContents);
        } catch (cleanupError) {
          throw new Error(
            `${this.displayName} removal was rolled back, but backup cleanup could not be completed; the backup was retained.`,
            { cause: cleanupError },
          );
        }
      }
      throw new Error(
        `${this.displayName} removal failed and was rolled back: ${error instanceof Error ? error.message : "persisted removal could not be verified"}`,
      );
    }
    if (receipt.previousContents)
      await removeConfigBackup(this.path, receipt.previousContents);
    return true;
  }
  private toClientEntry(entry: ServerConfiguration): Record<string, unknown> {
    const config = { ...entry } as Record<string, unknown>;
    delete config.name;
    delete config.transport;
    if (this.id === "cursor" && !entry.url) config.type = "stdio";
    if (
      (this.id === "copilot-vscode" || this.id === "copilot-cli") &&
      entry.url
    ) {
      config.type = entry.transport === "sse" ? "sse" : "http";
    } else if (
      (this.id === "copilot-vscode" || this.id === "copilot-cli") &&
      !entry.url
    ) {
      config.type = "stdio";
    }
    return config;
  }
}

async function restoreSnapshot(
  path: string,
  contents: Buffer | undefined,
): Promise<void> {
  if (contents) {
    await restoreConfigFile(path, contents);
    if (!(await readFile(path)).equals(contents))
      throw new Error("Restored configuration did not validate.");
    return;
  }
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("New configuration file remained after rollback.");
}

function matchesExpected(
  actual: unknown,
  expected: Record<string, unknown>,
): boolean {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual))
    return false;
  return Object.entries(expected).every(([key, value]) => {
    const observed = (actual as Record<string, unknown>)[key];
    if (key === "env") return isDeepStrictEqual(observed, value);
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      return matchesExpected(observed, value as Record<string, unknown>);
    return isDeepStrictEqual(observed, value);
  });
}

function mergeEntry(
  existing: unknown,
  expected: Record<string, unknown>,
  clientId?: ClientId,
): Record<string, unknown> {
  const prior =
    typeof existing === "object" &&
    existing !== null &&
    !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const preserved = { ...prior };
  for (const key of ["command", "args", "url", "type", "transport"])
    delete preserved[key];
  const priorEnv =
    typeof prior.env === "object" &&
    prior.env !== null &&
    !Array.isArray(prior.env)
      ? (prior.env as Record<string, string>)
      : {};
  const expectedEnv =
    typeof expected.env === "object" &&
    expected.env !== null &&
    !Array.isArray(expected.env)
      ? (expected.env as Record<string, string>)
      : undefined;
  const merged: Record<string, unknown> =
    clientId === "copilot-vscode" || clientId === "copilot-cli"
      ? {
          ...preserved,
          ...expected,
          ...(expectedEnv ? { env: { ...priorEnv, ...expectedEnv } } : {}),
        }
      : { ...preserved, ...expected };
  return merged;
}

export interface JsonClientPathOptions {
  platform?: NodeJS.Platform;
  home?: string;
  appData?: string;
  localAppData?: string;
  xdgConfigHome?: string;
  claudeProfiles?: string[];
  claudeConfigPath?: string;
}
export function resolveClaudeConfigPath(
  options: JsonClientPathOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const joinPath = platform === "win32" ? path.win32.join : path.posix.join;
  if (platform === "win32") {
    const explicitPath =
      options.claudeConfigPath ?? process.env.MCPGET_CLAUDE_CONFIG_PATH;
    if (explicitPath) return explicitPath;
    const localAppData =
      options.localAppData ??
      process.env.LOCALAPPDATA ??
      joinPath(home, "AppData", "Local");
    const profileRoot = joinPath(localAppData, "Claude-Data");
    const profiles =
      options.claudeProfiles ??
      (() => {
        try {
          return readdirSync(profileRoot, { withFileTypes: true })
            .filter(
              (item) => item.isDirectory() && item.name.startsWith("claude_"),
            )
            .map((item) => item.name);
        } catch {
          return [];
        }
      })();
    if (profiles.length > 1)
      throw new Error(
        `Multiple Claude Desktop data profiles exist under ${profileRoot}; set MCPGET_CLAUDE_CONFIG_PATH to the active profile configuration.`,
      );
    if (profiles.length === 1)
      return joinPath(profileRoot, profiles[0]!, "claude_desktop_config.json");
    const appData =
      options.appData ??
      process.env.APPDATA ??
      joinPath(home, "AppData", "Roaming");
    return joinPath(appData, "Claude", "claude_desktop_config.json");
  }
  if (platform === "darwin")
    return joinPath(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  return joinPath(
    options.xdgConfigHome ??
      process.env.XDG_CONFIG_HOME ??
      joinPath(home, ".config"),
    "Claude",
    "claude_desktop_config.json",
  );
}
export function resolveCursorConfigPath(
  options: Pick<JsonClientPathOptions, "home" | "platform"> = {},
): string {
  const joinPath =
    options.platform === "win32"
      ? path.win32.join
      : options.platform
        ? path.posix.join
        : path.join;
  return joinPath(options.home ?? homedir(), ".cursor", "mcp.json");
}

export function createJsonClientAdapters(
  options: JsonClientPathOptions = {},
): JsonClientAdapter[] {
  const claudePath = resolveClaudeConfigPath(options);
  const cursorPath = resolveCursorConfigPath(options);
  return [
    new JsonClientAdapter(
      "claude",
      "Claude Desktop (local stdio configuration)",
      claudePath,
    ),
    new JsonClientAdapter("cursor", "Cursor", cursorPath),
  ];
}
