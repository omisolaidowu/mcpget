import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  readJsonSnapshot,
  writeJsonSafely,
  type JsonWriteReceipt,
} from "./atomic-config.js";
import {
  ensureConfigBackupLifecycle,
  validateBackupClientConfiguration,
} from "./config-backup-lifecycle.js";
import {
  recordConfigBackupOutcome,
  removeConfigBackup,
  restoreConfigFile,
} from "./config-backup.js";
import { withFileLock } from "./file-lock.js";
import { OperationJournal } from "./operation-journal.js";
import {
  normalizeServerRegistration,
  type ClientAdapter,
  type ConfigurationScope,
  type ExistingServerRegistration,
  type ServerConfiguration,
} from "./types.js";

export class ClaudeCodeAdapter implements ClientAdapter {
  readonly id = "claude-code" as const;
  readonly displayName = "Claude Code";

  constructor(
    private readonly claudeJsonPath: string,
    private readonly scope: ConfigurationScope,
    private readonly projectRoot?: string,
    private readonly journal = new OperationJournal(),
  ) {}

  configPath(): string {
    return this.scope === "project"
      ? path.join(this.projectRoot ?? process.cwd(), ".mcp.json")
      : this.claudeJsonPath;
  }

  configScope(): ConfigurationScope {
    return this.scope;
  }

  async detect(): Promise<boolean> {
    try {
      await readFile(this.configPath(), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  async read(): Promise<Record<string, ServerConfiguration>> {
    const snapshot = await readJsonSnapshot(this.configPath());
    const root = snapshot.value;
    if (this.scope === "project") return this.readMcpServers(root);
    if (this.scope === "user") return this.readMcpServers(root);
    if (!this.projectRoot) return {};
    const projects = this.objectRecord(root.projects);
    return this.readMcpServers(this.objectRecord(projects[this.projectRoot]));
  }

  async readRegistrations(): Promise<ExistingServerRegistration[]> {
    const servers = await this.read();
    return Object.entries(servers).map(([name, entry]) =>
      normalizeServerRegistration(
        "claude-code",
        this.configPath(),
        this.scope,
        {
          ...entry,
          name,
        },
      ),
    );
  }

  async add(entry: ServerConfiguration, operationId?: string): Promise<void> {
    if (this.scope === "project") await this.assertProjectTrusted();
    await withFileLock(this.configPath(), () =>
      this.addUnlocked(entry, operationId),
    );
  }

  private async addUnlocked(
    entry: ServerConfiguration,
    operationId?: string,
  ): Promise<void> {
    await ensureConfigBackupLifecycle(
      this.configPath(),
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
    const snapshot = await readJsonSnapshot(this.configPath());
    const root = snapshot.value;
    const clientEntry = this.toClientEntry(entry);
    const current = await this.read();
    if (
      isDeepStrictEqual(
        current[entry.name],
        entryForComparison(entry, clientEntry),
      )
    ) {
      const verification = await this.verify(entry);
      if (!verification.verified) throw new Error(verification.detail);
      return;
    }

    let next: Record<string, unknown>;
    if (this.scope === "project") {
      const existing = this.objectRecord(root.mcpServers);
      next = {
        ...root,
        mcpServers: {
          ...existing,
          [entry.name]: mergeEntry(existing[entry.name], clientEntry),
        },
      };
    } else if (this.scope === "user") {
      const existing = this.objectRecord(root.mcpServers);
      next = {
        ...root,
        mcpServers: {
          ...existing,
          [entry.name]: mergeEntry(existing[entry.name], clientEntry),
        },
      };
    } else {
      if (!this.projectRoot)
        throw new Error("Claude Code local scope has no project context.");
      const projects = this.objectRecord(root.projects);
      const project = this.objectRecord(projects[this.projectRoot]);
      const existing = this.objectRecord(project.mcpServers);
      next = {
        ...root,
        projects: {
          ...projects,
          [this.projectRoot]: {
            ...project,
            mcpServers: {
              ...existing,
              [entry.name]: mergeEntry(existing[entry.name], clientEntry),
            },
          },
        },
      };
    }

    let receipt: JsonWriteReceipt | undefined;
    try {
      receipt = await writeJsonSafely(this.configPath(), next, {
        ...(operationId ? { operationId } : {}),
        operationKind: "install",
        deferCommitConfirmation: true,
      });
      const verification = await this.verify(entry);
      if (!verification.verified) throw new Error(verification.detail);
      if (receipt.previousContents)
        await recordConfigBackupOutcome(
          this.configPath(),
          receipt.previousContents,
          "commit_confirmed",
        );
    } catch (error) {
      if (!receipt) throw error;
      await this.rollbackWrite(receipt.previousContents, error);
    }
    if (receipt?.previousContents)
      await removeConfigBackup(this.configPath(), receipt.previousContents);
  }

  async verify(entry: ServerConfiguration): Promise<{
    verified: boolean;
    detail: string;
  }> {
    try {
      const servers = await this.read();
      const actual = servers[entry.name];
      if (!actual) {
        return {
          verified: false,
          detail: `Claude Code ${this.scope}-scope entry ${entry.name} was not found at ${this.configPath()}.`,
        };
      }
      const matches = entry.url
        ? actual.url === entry.url
        : actual.command === entry.command &&
          isDeepStrictEqual(actual.args ?? [], entry.args ?? []) &&
          isDeepStrictEqual(actual.env ?? {}, entry.env ?? {});
      if (!matches) {
        return {
          verified: false,
          detail: `Claude Code ${this.scope}-scope entry ${entry.name} does not match the expected configuration at ${this.configPath()}.`,
        };
      }
      return {
        verified: true,
        detail: `Exact Claude Code ${this.scope}-scope entry re-read from ${this.configPath()}.`,
      };
    } catch (error) {
      return {
        verified: false,
        detail:
          error instanceof Error
            ? error.message
            : "Claude Code configuration could not be re-read.",
      };
    }
  }

  async verifyRemoved(name: string): Promise<boolean> {
    return !(name in (await this.read()));
  }

  async projectApprovalStatus(
    name: string,
  ): Promise<"approved" | "disabled" | "pending"> {
    if (this.scope !== "project") return "approved";
    if (!this.projectRoot) return "pending";
    try {
      const root = JSON.parse(await readFile(this.claudeJsonPath, "utf8")) as {
        projects?: Record<
          string,
          {
            enabledMcpjsonServers?: string[];
            disabledMcpjsonServers?: string[];
          }
        >;
      };
      const project = root.projects?.[this.projectRoot];
      if (project?.disabledMcpjsonServers?.includes(name)) return "disabled";
      if (project?.enabledMcpjsonServers?.includes(name)) return "approved";
      return "pending";
    } catch {
      return "pending";
    }
  }

  async remove(name: string, operationId?: string): Promise<boolean> {
    if (this.scope === "project") await this.assertProjectTrusted();
    return withFileLock(this.configPath(), () =>
      this.removeUnlocked(name, operationId),
    );
  }

  private async removeUnlocked(
    name: string,
    operationId?: string,
  ): Promise<boolean> {
    await ensureConfigBackupLifecycle(
      this.configPath(),
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
    const snapshot = await readJsonSnapshot(this.configPath());
    const root = snapshot.value;
    const servers = await this.read();
    if (!(name in servers)) return false;
    let next: Record<string, unknown>;
    if (this.scope === "project") {
      const existing = this.objectRecord(root.mcpServers);
      const remaining = { ...existing };
      delete remaining[name];
      next = { ...root, mcpServers: remaining };
    } else if (this.scope === "user") {
      const existing = this.objectRecord(root.mcpServers);
      const remaining = { ...existing };
      delete remaining[name];
      next = { ...root, mcpServers: remaining };
    } else {
      if (!this.projectRoot) return false;
      const projects = this.objectRecord(root.projects);
      const project = this.objectRecord(projects[this.projectRoot]);
      const existing = this.objectRecord(project.mcpServers);
      const remaining = { ...existing };
      delete remaining[name];
      next = {
        ...root,
        projects: {
          ...projects,
          [this.projectRoot]: { ...project, mcpServers: remaining },
        },
      };
    }
    let receipt: JsonWriteReceipt | undefined;
    try {
      receipt = await writeJsonSafely(this.configPath(), next, {
        ...(operationId ? { operationId } : {}),
        operationKind: "remove",
        deferCommitConfirmation: true,
      });
      if (!(await this.verifyRemoved(name)))
        throw new Error(`Claude Code still lists ${name} after removal.`);
      if (receipt.previousContents)
        await recordConfigBackupOutcome(
          this.configPath(),
          receipt.previousContents,
          "commit_confirmed",
        );
    } catch (error) {
      if (!receipt) throw error;
      await this.rollbackWrite(receipt.previousContents, error);
    }
    if (receipt?.previousContents)
      await removeConfigBackup(this.configPath(), receipt.previousContents);
    return true;
  }

  private async assertProjectTrusted(): Promise<void> {
    if (!this.projectRoot)
      throw new Error("Claude Code project scope has no project root.");
    try {
      const root = JSON.parse(await readFile(this.claudeJsonPath, "utf8")) as {
        projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
      };
      if (root.projects?.[this.projectRoot]?.hasTrustDialogAccepted !== true) {
        throw new Error(
          `Claude Code project trust is not established for ${this.projectRoot}. Trust the project in Claude Code before adding or removing project-scoped MCP servers.`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("project trust"))
        throw error;
      throw new Error(
        `Claude Code project trust could not be verified for ${this.projectRoot}.`,
      );
    }
  }

  private readMcpServers(
    root: Record<string, unknown>,
  ): Record<string, ServerConfiguration> {
    const servers = this.objectRecord(root.mcpServers);
    const output: Record<string, ServerConfiguration> = {};
    for (const [name, value] of Object.entries(servers)) {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        continue;
      const entry = value as Record<string, unknown>;
      output[name] = normalizeClaudeEntry(name, entry);
    }
    return output;
  }

  private objectRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private toClientEntry(entry: ServerConfiguration): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    if (entry.url) {
      const transport = entry.transport ?? entry.type;
      output.type =
        transport === "sse" ? "sse" : transport === "ws" ? "ws" : "http";
      output.url = entry.url;
    } else {
      output.type = "stdio";
      if (entry.command) output.command = entry.command;
      if (entry.args) output.args = entry.args;
    }
    if (entry.env) output.env = { ...entry.env };
    return output;
  }

  private async rollbackWrite(
    previousContents: Buffer | undefined,
    error: unknown,
  ): Promise<never> {
    try {
      if (previousContents) {
        await restoreConfigFile(this.configPath(), previousContents);
      } else {
        await unlink(this.configPath()).catch(() => undefined);
      }
      throw new Error(
        `Claude Code configuration update failed and was rolled back: ${error instanceof Error ? error.message : "persisted entry could not be verified"}`,
      );
    } catch (rollbackError) {
      if (previousContents) {
        await recordConfigBackupOutcome(
          this.configPath(),
          previousContents,
          "rollback_failed",
        ).catch(() => undefined);
      }
      throw new Error(
        `Claude Code configuration update failed and rollback could not be confirmed; recovery backup retained at ${this.configPath()}.mcpget.bak.`,
        { cause: rollbackError },
      );
    }
  }
}

function normalizeClaudeEntry(
  name: string,
  entry: Record<string, unknown>,
): ServerConfiguration {
  const type =
    typeof entry.type === "string" ? entry.type : entry.url ? "http" : "stdio";
  const env =
    typeof entry.env === "object" &&
    entry.env !== null &&
    !Array.isArray(entry.env)
      ? (Object.fromEntries(
          Object.entries(entry.env).filter(
            (item) => typeof item[1] === "string",
          ),
        ) as Record<string, string>)
      : undefined;
  return {
    name,
    ...(typeof entry.command === "string" ? { command: entry.command } : {}),
    ...(Array.isArray(entry.args)
      ? {
          args: entry.args.filter(
            (item): item is string => typeof item === "string",
          ),
        }
      : {}),
    ...(typeof entry.url === "string" ? { url: entry.url } : {}),
    ...(env ? { env } : {}),
    transport: type,
    ...(type === "stdio"
      ? { type: "stdio" as const }
      : type === "http" || type === "streamable-http"
        ? { type: "http" as const }
        : {}),
  };
}

function mergeEntry(
  existing: unknown,
  expected: Record<string, unknown>,
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
  return {
    ...preserved,
    ...expected,
    ...(expectedEnv ? { env: { ...priorEnv, ...expectedEnv } } : {}),
  };
}

function entryForComparison(
  entry: ServerConfiguration,
  clientEntry: Record<string, unknown>,
): ServerConfiguration {
  return {
    name: entry.name,
    ...Object.fromEntries(
      Object.entries(clientEntry).filter(([key]) =>
        ["command", "args", "url", "env", "type"].includes(key),
      ),
    ),
  } as ServerConfiguration;
}
