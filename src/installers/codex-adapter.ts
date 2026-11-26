import { spawn } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import importPath from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify, type TomlTable } from "smol-toml";
import type {
  ClientAdapter,
  ConfigurationScope,
  ExistingServerRegistration,
  ServerConfiguration,
} from "./types.js";
import { normalizeServerRegistration } from "./types.js";
import {
  assertNoConfigBackupArtifacts,
  createConfigBackup,
  removeConfigBackup,
  recordConfigBackupOutcome,
  restoreConfigFile,
  type ConfigBackupContext,
} from "./config-backup.js";
import {
  ensureConfigBackupLifecycle,
  validateBackupClientConfiguration,
} from "./config-backup-lifecycle.js";
import { renameWithRetry, withFileLock } from "./file-lock.js";
import { OperationJournal } from "./operation-journal.js";

export function codexConfigPath(
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
  platform: NodeJS.Platform = process.platform,
): string {
  const joinPath =
    platform === "win32" ? importPath.win32.join : importPath.posix.join;
  return joinPath(codexHome, "config.toml");
}

export class CodexAdapter implements ClientAdapter {
  readonly id = "codex" as const;
  readonly displayName = "OpenAI Codex";
  constructor(
    private readonly path = codexConfigPath(),
    private readonly runner: CodexCommandRunner = runCodexCommand,
    private readonly journal = new OperationJournal(),
    private readonly scope: ConfigurationScope = "user",
  ) {}
  configPath(): string {
    return this.path;
  }
  configScope(): ConfigurationScope {
    return this.scope;
  }
  async detect(): Promise<boolean> {
    try {
      return (await stat(this.path)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async read(): Promise<Record<string, ServerConfiguration>> {
    return readCodexServers(await this.readTomlDocument(false), this.path);
  }
  async readRegistrations(): Promise<ExistingServerRegistration[]> {
    const servers = await this.read();
    return Object.values(servers).map((entry) =>
      normalizeServerRegistration(this.id, this.path, this.scope, entry),
    );
  }

  private async readTomlDocument(allowMissing: boolean): Promise<TomlTable> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const parent = await stat(dirname(this.path)).catch(() => undefined);
        if (parent && !parent.isDirectory())
          throw new Error(
            `Codex ${this.scope}-scope configuration is inaccessible at ${this.path}.`,
          );
        if (allowMissing) return {};
        throw new Error(
          `Codex ${this.scope}-scope configuration is missing at ${this.path}.`,
        );
      }
      if (
        code === "EACCES" ||
        code === "EPERM" ||
        code === "EISDIR" ||
        code === "ENOTDIR"
      ) {
        throw new Error(
          `Codex ${this.scope}-scope configuration is inaccessible at ${this.path}.`,
        );
      }
      throw new Error(
        `Could not read Codex ${this.scope}-scope configuration at ${this.path}.`,
      );
    }

    let config: TomlTable;
    try {
      config = parse(text, { unsafeKeyBehaviour: "throw" });
    } catch {
      throw new Error(
        `Codex ${this.scope}-scope configuration is malformed TOML at ${this.path}.`,
      );
    }
    getCodexServerTable(config, this.path);
    return config;
  }

  async add(entry: ServerConfiguration, operationId?: string): Promise<void> {
    await withFileLock(this.path, () => this.addUnlocked(entry, operationId));
  }
  private async addUnlocked(
    entry: ServerConfiguration,
    operationId?: string,
  ): Promise<void> {
    let prior: Buffer | undefined;
    try {
      prior = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await ensureConfigBackupLifecycle(
      this.path,
      this.id,
      (configPath) =>
        validateBackupClientConfiguration(
          this.id,
          this.displayName,
          configPath,
          this.scope,
        ),
      this.journal,
      operationId,
    );
    await assertNoConfigBackupArtifacts(this.path);
    let secrets = Object.values(entry.env ?? {});
    const document = await this.readTomlDocument(true);
    const servers = getCodexServerTable(document, this.path, true) ?? {};
    const previous = getCodexServerEntry(servers[entry.name], entry.name);
    const previousEnv =
      previous && !entry.url ? readCodexEnv(previous, entry.name) : undefined;
    const hasEnvironment =
      !entry.url && (previous?.env !== undefined || entry.env !== undefined);
    const effectiveEnv = hasEnvironment
      ? { ...previousEnv, ...entry.env }
      : undefined;
    const effectiveEntry: ServerConfiguration = entry.url
      ? { ...entry, transport: "streamable_http" }
      : {
          ...entry,
          args: entry.args ?? [],
          ...(effectiveEnv ? { env: effectiveEnv } : {}),
        };
    secrets = Object.values(effectiveEnv ?? {});

    const current = readCodexServers(document, this.path)[entry.name];
    if (current && isDeepStrictEqual(current, effectiveEntry)) {
      const verification = await this.verify(effectiveEntry);
      if (!verification.verified) throw new Error(verification.detail);
      return;
    }

    servers[entry.name] = updateCodexServer(previous, entry, effectiveEnv);
    document.mcp_servers = servers;
    let backupPath: string | undefined;
    let writeCompleted = false;
    try {
      backupPath = await this.writeTomlDocument(document, prior, {
        ...(operationId ? { operationId } : {}),
        operationKind: "install",
      });
      writeCompleted = true;
      const verification = await this.verify(effectiveEntry);
      if (!verification.verified) throw new Error(verification.detail);
      if (prior && backupPath)
        await recordConfigBackupOutcome(this.path, prior, "commit_confirmed");
    } catch (error) {
      if (!writeCompleted)
        throw new Error(
          `Codex configuration update failed: ${safeError(error, secrets)}`,
          { cause: error },
        );
      await this.rollback(prior, backupPath, error, "update", secrets);
    }
    if (prior && backupPath) await removeConfigBackup(this.path, prior);
  }

  async verify(
    entry: ServerConfiguration,
  ): Promise<{ verified: boolean; detail: string }> {
    try {
      const actual = (await this.read())[entry.name];
      const expected = entry.url
        ? { name: entry.name, url: entry.url, transport: "streamable_http" }
        : {
            name: entry.name,
            command: entry.command,
            args: entry.args ?? [],
            ...(entry.env ? { env: entry.env } : {}),
          };
      if (!actual || !isDeepStrictEqual(actual, expected)) {
        return {
          verified: false,
          detail: `Codex ${this.scope}-scope entry ${entry.name} was not persisted with the expected executable/endpoint, arguments, and environment in ${this.path}.`,
        };
      }
      return {
        verified: true,
        detail: `Exact server entry re-read directly from Codex ${this.scope}-scope configuration (${this.path}).`,
      };
    } catch (error) {
      return {
        verified: false,
        detail: `Codex configuration could not be independently verified: ${safeError(error, Object.values(entry.env ?? {}))}`,
      };
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
    let prior: Buffer;
    try {
      prior = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error(
        `Could not read Codex ${this.scope}-scope configuration at ${this.path}.`,
      );
    }
    await ensureConfigBackupLifecycle(
      this.path,
      this.id,
      (configPath) =>
        validateBackupClientConfiguration(
          this.id,
          this.displayName,
          configPath,
          this.scope,
        ),
      this.journal,
      operationId,
    );
    await assertNoConfigBackupArtifacts(this.path);
    const document = await this.readTomlDocument(false);
    const servers = getCodexServerTable(document, this.path, true) ?? {};
    if (!(name in servers)) return false;
    delete servers[name];
    document.mcp_servers = servers;
    let backupPath: string | undefined;
    let writeCompleted = false;
    try {
      backupPath = await this.writeTomlDocument(document, prior, {
        ...(operationId ? { operationId } : {}),
        operationKind: "remove",
      });
      writeCompleted = true;
      if (!(await this.verifyRemoved(name)))
        throw new Error(`Codex still lists ${name} after removal.`);
      if (backupPath)
        await recordConfigBackupOutcome(this.path, prior, "commit_confirmed");
    } catch (error) {
      if (!writeCompleted)
        throw new Error(
          `Codex configuration removal failed: ${safeError(error)}`,
          { cause: error },
        );
      await this.rollback(prior, backupPath, error, "removal");
    }
    if (backupPath) await removeConfigBackup(this.path, prior);
    return true;
  }

  async verifyRemoved(name: string): Promise<boolean> {
    try {
      return !(
        name in readCodexServers(await this.readTomlDocument(true), this.path)
      );
    } catch {
      return false;
    }
  }

  async authenticate(name: string): Promise<void> {
    await this.run(["mcp", "login", name], true);
  }

  private run(
    args: string[],
    interactive = false,
  ): Promise<string | undefined> {
    return this.runner(args, interactive);
  }

  private async writeTomlDocument(
    document: TomlTable,
    prior: Buffer | undefined,
    context: ConfigBackupContext,
  ): Promise<string | undefined> {
    await mkdir(dirname(this.path), { recursive: true });
    await assertNoConfigBackupArtifacts(this.path);
    const backupPath = prior
      ? await createConfigBackup(this.path, prior, context)
      : undefined;
    const temporary = `${this.path}.mcpget-${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${stringify(document).trimEnd()}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await renameWithRetry(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      try {
        await restoreSnapshot(this.path, prior);
        if (backupPath && prior) {
          await recordConfigBackupOutcome(
            this.path,
            prior,
            "rollback_confirmed",
          );
          await removeConfigBackup(this.path, prior);
        }
      } catch (rollbackError) {
        if (backupPath && prior)
          await recordConfigBackupOutcome(
            this.path,
            prior,
            "rollback_failed",
          ).catch(() => undefined);
        throw new Error(
          `Codex configuration write failed and rollback could not be confirmed; recovery backup retained at ${backupPath ?? `${this.path}.mcpget.bak`}.`,
          { cause: rollbackError },
        );
      }
      throw error;
    }
    return backupPath;
  }

  private async rollback(
    prior: Buffer | undefined,
    backupPath: string | undefined,
    error: unknown,
    operation: "update" | "removal",
    secrets: string[] = [],
  ): Promise<never> {
    try {
      await restoreSnapshot(this.path, prior);
    } catch (rollbackError) {
      if (backupPath && prior)
        await recordConfigBackupOutcome(
          this.path,
          prior,
          "rollback_failed",
        ).catch(() => undefined);
      const recoveryNote = prior
        ? `; recovery backup retained at ${backupPath ?? `${this.path}.mcpget.bak`}`
        : "";
      throw new Error(
        `Codex configuration ${operation} failed and rollback also failed${recoveryNote}: ${safeError(rollbackError, secrets)}`,
        { cause: error },
      );
    }
    if (backupPath && prior) {
      try {
        await recordConfigBackupOutcome(this.path, prior, "rollback_confirmed");
        await removeConfigBackup(this.path, prior);
      } catch (cleanupError) {
        throw new Error(
          `Codex configuration ${operation} was rolled back, but backup cleanup could not be completed; the backup was retained: ${safeError(cleanupError, secrets)}`,
          { cause: error },
        );
      }
    }
    throw new Error(
      `Codex configuration ${operation} failed and was rolled back: ${safeError(error, secrets)}`,
      { cause: error },
    );
  }
}

async function restoreSnapshot(
  path: string,
  contents: Buffer | undefined,
): Promise<void> {
  if (contents) {
    await restoreConfigFile(path, contents);
    if (!(await readFile(path)).equals(contents))
      throw new Error("Restored Codex configuration did not validate.");
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
  throw new Error("New Codex configuration remained after rollback.");
}

export type CodexCommandRunner = (
  args: string[],
  interactive: boolean,
) => Promise<string | undefined>;

function getCodexServerTable(
  document: TomlTable,
  path: string,
  create = false,
): TomlTable | undefined {
  const servers = document.mcp_servers;
  if (servers === undefined) return create ? {} : undefined;
  if (!isTomlTable(servers))
    throw new Error(
      `Codex configuration has an unsupported mcp_servers schema at ${path}.`,
    );
  return servers;
}

function readCodexServers(
  document: TomlTable,
  path: string,
): Record<string, ServerConfiguration> {
  const servers = getCodexServerTable(document, path);
  if (!servers) return {};
  const entries: Array<[string, ServerConfiguration]> = [];
  for (const [name, value] of Object.entries(servers)) {
    if (!isTomlTable(value))
      throw new Error(
        `Codex MCP server "${name}" has an unsupported configuration schema.`,
      );
    const command = value.command;
    const url = value.url;
    if (command !== undefined && typeof command !== "string")
      throw new Error(
        `Codex MCP server "${name}" has an unsupported command schema.`,
      );
    if (url !== undefined && typeof url !== "string")
      throw new Error(
        `Codex MCP server "${name}" has an unsupported URL schema.`,
      );
    if (typeof command === "string" && url === undefined) {
      const args = value.args;
      if (args !== undefined && !isStringArray(args)) {
        throw new Error(
          `Codex MCP server "${name}" has an unsupported stdio arguments schema.`,
        );
      }
      const env = readCodexEnv(value, name);
      entries.push([
        name,
        {
          name,
          command,
          args: args === undefined ? [] : [...args],
          ...(env ? { env } : {}),
        },
      ]);
    } else if (typeof url === "string" && command === undefined) {
      entries.push([name, { name, url, transport: "streamable_http" }]);
    } else {
      throw new Error(
        `Codex MCP server "${name}" has an unsupported configuration schema.`,
      );
    }
  }
  return Object.fromEntries(entries);
}

function getCodexServerEntry(
  value: TomlTable[string] | undefined,
  name: string,
): TomlTable | undefined {
  if (value === undefined) return undefined;
  if (!isTomlTable(value))
    throw new Error(
      `Codex MCP server "${name}" has an unsupported configuration schema.`,
    );
  return value;
}

function readCodexEnv(
  server: TomlTable,
  name: string,
): Record<string, string> | undefined {
  const value = server.env;
  if (value === undefined) return undefined;
  if (!isTomlTable(value))
    throw new Error(
      `Codex MCP server "${name}" has an unsupported environment schema.`,
    );
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string")
      throw new Error(
        `Codex MCP server "${name}" has an unsupported environment schema.`,
      );
    env[key] = item;
  }
  return env;
}

function updateCodexServer(
  previous: TomlTable | undefined,
  entry: ServerConfiguration,
  env: Record<string, string> | undefined,
): TomlTable {
  const server: TomlTable = previous ? { ...previous } : {};
  if (entry.url) {
    for (const key of ["command", "args", "env", "env_vars", "cwd"])
      delete server[key];
    server.url = entry.url;
  } else {
    for (const key of [
      "url",
      "auth",
      "bearer_token_env_var",
      "http_headers",
      "env_http_headers",
      "http_headers_helper",
    ])
      delete server[key];
    if (!entry.command)
      throw new Error("Codex stdio server configuration requires a command.");
    server.command = entry.command;
    server.args = [...(entry.args ?? [])];
    if (env) server.env = { ...env };
    else delete server.env;
  }
  return server;
}

function isTomlTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function runCodexCommand(
  args: string[],
  interactive: boolean,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      shell: false,
      cwd: homedir(),
      stdio: interactive ? "inherit" : ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    if (!interactive)
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = `${stdout}${chunk.toString("utf8")}`.slice(-2_000_000);
      });
    child.once("error", () =>
      reject(new Error("Codex CLI was not found or could not be started.")),
    );
    child.once("exit", (code) =>
      code === 0
        ? resolve(interactive ? undefined : stdout)
        : reject(new Error(`Codex CLI exited with status ${code}.`)),
    );
  });
}

function safeError(error: unknown, secrets: string[] = []): string {
  if (!(error instanceof Error)) return "unknown error";
  let message = error.message;
  for (const secret of secrets)
    if (secret) message = message.split(secret).join("[REDACTED]");
  return [...message]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .slice(0, 400);
}
