import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InstallationStateStore } from "../../src/installers/state-store.js";
import { OperationJournal } from "../../src/installers/operation-journal.js";
import {
  cleanupOrphanedManagedPackage,
  inspectManagedPackages,
  managedInstallPath,
  readManagedPackageMetadata,
  releaseManagedAssociation,
  updateManagedMetadata,
} from "../../src/installers/managed-npm.js";
import {
  archiveOrphanedConfigBackup,
  inspectRecoveryState,
  recoverPendingOperations,
} from "../../src/installers/recovery.js";
import { ensureConfigBackupLifecycle } from "../../src/installers/config-backup-lifecycle.js";
import {
  configBackupPath,
  createConfigBackup,
  recordConfigBackupOutcome,
  sha256,
} from "../../src/installers/config-backup.js";
import { CodexAdapter } from "../../src/installers/codex-adapter.js";
import { JsonClientAdapter } from "../../src/installers/json-client-adapter.js";
import { createInstallationRecord } from "../../src/models/installation.js";
import type {
  ClientAdapter,
  ServerConfiguration,
} from "../../src/installers/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function adapter(
  configPath: string,
  entries: Record<string, ServerConfiguration>,
): ClientAdapter {
  return {
    id: "codex",
    displayName: "Codex",
    configPath: () => configPath,
    configScope: () => "user",
    detect: async () => true,
    read: async () => structuredClone(entries),
    add: async (entry) => {
      entries[entry.name] = entry;
    },
    verify: async (entry) => ({
      verified: entries[entry.name] !== undefined,
      detail: "configuration present",
    }),
    remove: async (name) => {
      if (!(name in entries)) return false;
      delete entries[name];
      return true;
    },
    verifyRemoved: async (name) => !(name in entries),
  };
}

describe("installation recovery journal", () => {
  it("reports interrupted operations without exposing configuration environment values", async () => {
    const root = await temporaryDirectory("mcpget-recovery-report-");
    const journal = new OperationJournal(path.join(root, "operations"));
    const configPath = path.join(root, "config.json");
    const secret = "top-secret-test-value";
    const client = adapter(configPath, {
      sample: {
        name: "sample",
        command: "node",
        args: ["server.js"],
        env: { API_TOKEN: secret },
      },
    });
    await journal.begin({
      kind: "install",
      client: "codex",
      configPath,
      configName: "sample",
      serverIdentifier: "sample-id",
    });

    const findings = await inspectRecoveryState({
      adapters: [client],
      stateStore: new InstallationStateStore(path.join(root, "state.json")),
      journal,
      installRoot: path.join(root, "missing-installations"),
    });

    expect(findings.map((item) => item.kind)).toContain(
      "interrupted_operation",
    );
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it("reports journal entries whose Codex scope is outside the discovered context", async () => {
    const root = await temporaryDirectory("mcpget-recovery-unavailable-scope-");
    const journal = new OperationJournal(path.join(root, "operations"));
    const availablePath = path.join(
      root,
      "current-project",
      ".codex",
      "config.toml",
    );
    const unavailablePath = path.join(
      root,
      "other-project",
      ".codex",
      "config.toml",
    );
    const client = adapter(availablePath, {});
    await journal.begin({
      kind: "install",
      client: "codex",
      configPath: unavailablePath,
      configScope: "project",
      configName: "sample",
      serverIdentifier: "sample-id",
    });

    const actions = await recoverPendingOperations({
      adapters: [client],
      stateStore: new InstallationStateStore(path.join(root, "state.json")),
      journal,
      installRoot: path.join(root, "missing-installations"),
      skipPackageCleanup: true,
      includeUnmatchedOperations: true,
    });

    expect(actions).toMatchObject([
      {
        status: "blocked",
        client: "codex",
        configScope: "project",
        configPath: unavailablePath,
        detail: expect.stringContaining("not available"),
      },
    ]);
    expect(await journal.list()).toHaveLength(1);
  });

  it("reports and preserves unresolved configuration backups during recovery", async () => {
    const root = await temporaryDirectory("mcpget-recovery-backup-");
    const configPath = path.join(root, "config.toml");
    const backupPath = `${configPath}.mcpget.bak`;
    const journal = new OperationJournal(path.join(root, "operations"));
    const store = new InstallationStateStore(path.join(root, "state.json"));
    const client = adapter(configPath, {
      sample: { name: "sample", command: "node", args: [] },
    });
    await writeFile(configPath, "current config");
    await writeFile(backupPath, "original config with credentials", {
      mode: 0o600,
    });
    const operation = await journal.begin({
      kind: "install",
      client: "codex",
      configPath,
      configName: "sample",
      serverIdentifier: "sample-id",
    });

    const dependencies = {
      adapters: [client],
      stateStore: store,
      journal,
      installRoot: path.join(root, "missing-installations"),
    };
    const findings = await inspectRecoveryState(dependencies);
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: "ambiguous_configuration_backup",
        path: backupPath,
      }),
    );

    const actions = await recoverPendingOperations(dependencies);
    expect(actions).toContainEqual(
      expect.objectContaining({ operationId: operation.id, status: "blocked" }),
    );
    expect(await journal.list()).toHaveLength(1);
    expect(await readFile(backupPath, "utf8")).toBe(
      "original config with credentials",
    );
  });

  it("classifies and archives a stale valid backup without changing active configuration", async () => {
    const root = await temporaryDirectory("mcpget-recovery-orphan-");
    const configPath = path.join(root, "client.json");
    const backupPath = configBackupPath(configPath);
    const original = `${JSON.stringify({
      theme: "original",
      mcpServers: {
        sample: { command: "node", args: ["old.js"] },
      },
    })}\n`;
    const active = `${JSON.stringify({
      theme: "keep",
      otherSetting: true,
      mcpServers: {
        sample: { command: "node", args: ["new.js"] },
        unrelated: { command: "python", args: ["other.py"] },
      },
    })}\n`;
    const journal = new OperationJournal(path.join(root, "operations"));
    const adapter = new JsonClientAdapter("cursor", "Cursor", configPath);
    await writeFile(configPath, active);
    await writeFile(backupPath, original, { mode: 0o600 });

    const findings = await inspectRecoveryState({
      adapters: [adapter],
      stateStore: new InstallationStateStore(path.join(root, "state.json")),
      journal,
      installRoot: path.join(root, "missing-installations"),
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: "orphaned_configuration_backup",
        status: "orphaned",
        path: backupPath,
      }),
    );

    const action = await archiveOrphanedConfigBackup(adapter, journal);
    expect(action.status).toBe("reconciled");
    expect(await readFile(configPath, "utf8")).toBe(active);
    await expect(readFile(backupPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const resolutions = await journal.listBackupResolutions();
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.status).toBe("completed");
    expect(await readFile(resolutions[0]!.archivePath, "utf8")).toBe(original);

    expect(await adapter.remove("sample")).toBe(true);
    const remaining = JSON.parse(await readFile(configPath, "utf8")) as {
      theme: string;
      otherSetting: boolean;
      mcpServers: Record<string, unknown>;
    };
    expect(remaining).toMatchObject({
      theme: "keep",
      otherSetting: true,
    });
    expect(remaining.mcpServers).toHaveProperty("unrelated");
    expect(remaining.mcpServers).not.toHaveProperty("sample");
  });

  it("validates and archives a stale Codex TOML backup", async () => {
    const root = await temporaryDirectory("mcpget-recovery-codex-archive-");
    const configPath = path.join(root, "config.toml");
    const backupPath = configBackupPath(configPath);
    const original = [
      'model = "old"',
      "",
      "[mcp_servers.sample]",
      'command = "node"',
      'args = ["old.js"]',
      "",
    ].join("\n");
    const active = [
      'model = "keep"',
      "",
      "[mcp_servers.sample]",
      'command = "node"',
      'args = ["new.js"]',
      "",
    ].join("\n");
    await writeFile(configPath, active);
    await writeFile(backupPath, original, { mode: 0o600 });
    const journal = new OperationJournal(path.join(root, "operations"));
    const adapter = new CodexAdapter(configPath);

    await expect(
      archiveOrphanedConfigBackup(adapter, journal),
    ).resolves.toMatchObject({ status: "reconciled" });

    const resolution = (await journal.listBackupResolutions())[0]!;
    expect(await readFile(resolution.archivePath, "utf8")).toBe(original);
    expect(await readFile(configPath, "utf8")).toBe(active);
    await expect(readFile(backupPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps a backup from a confirmed incomplete transaction blocked", async () => {
    const root = await temporaryDirectory("mcpget-recovery-incomplete-");
    const configPath = path.join(root, "client.json");
    const original = Buffer.from(
      '{"mcpServers":{"sample":{"command":"node"}}}\n',
    );
    const journal = new OperationJournal(path.join(root, "operations"));
    const operation = await journal.begin({
      kind: "remove",
      client: "cursor",
      configPath,
      configName: "sample",
      serverIdentifier: "sample-id",
    });
    await writeFile(configPath, original);
    await createConfigBackup(configPath, original, {
      operationId: operation.id,
      operationKind: "remove",
    });
    const adapter = new JsonClientAdapter("cursor", "Cursor", configPath);
    const findings = await inspectRecoveryState({
      adapters: [adapter],
      stateStore: new InstallationStateStore(path.join(root, "state.json")),
      journal,
      installRoot: path.join(root, "missing-installations"),
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: "confirmed_incomplete_configuration_transaction",
        status: "incomplete",
      }),
    );
    await expect(archiveOrphanedConfigBackup(adapter, journal)).rejects.toThrow(
      /orphaned backup/i,
    );
    expect(await readFile(configBackupPath(configPath))).toEqual(original);
  });

  it("keeps a backup from a confirmed failed rollback blocked", async () => {
    const root = await temporaryDirectory("mcpget-recovery-rollback-failed-");
    const configPath = path.join(root, "client.json");
    const original = Buffer.from(
      '{"mcpServers":{"sample":{"command":"node"}}}\n',
    );
    await writeFile(configPath, original);
    await createConfigBackup(configPath, original, {
      operationKind: "remove",
    });
    await recordConfigBackupOutcome(configPath, original, "rollback_failed");
    const journal = new OperationJournal(path.join(root, "operations"));
    const adapter = new JsonClientAdapter("cursor", "Cursor", configPath);
    const findings = await inspectRecoveryState({
      adapters: [adapter],
      stateStore: new InstallationStateStore(path.join(root, "state.json")),
      journal,
      installRoot: path.join(root, "missing-installations"),
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: "confirmed_failed_configuration_rollback",
        status: "failed",
      }),
    );
    await expect(archiveOrphanedConfigBackup(adapter, journal)).rejects.toThrow(
      /orphaned backup/i,
    );
    expect(await readFile(configBackupPath(configPath))).toEqual(original);
  });

  it("does not treat a committed config backup as stale while its operation is pending", async () => {
    const root = await temporaryDirectory("mcpget-recovery-pending-commit-");
    const configPath = path.join(root, "client.json");
    const original = Buffer.from(
      '{"mcpServers":{"sample":{"command":"node","args":["old.js"]}}}\n',
    );
    const active = Buffer.from(
      '{"mcpServers":{"sample":{"command":"node","args":["new.js"]}}}\n',
    );
    const journal = new OperationJournal(path.join(root, "operations"));
    const operation = await journal.begin({
      kind: "install",
      client: "cursor",
      configPath,
      configName: "sample",
      serverIdentifier: "sample-id",
    });
    await writeFile(configPath, original);
    await createConfigBackup(configPath, original, {
      operationId: operation.id,
      operationKind: "install",
    });
    await writeFile(configPath, active);
    await recordConfigBackupOutcome(configPath, original, "commit_confirmed");

    const adapter = new JsonClientAdapter("cursor", "Cursor", configPath);
    const store = new InstallationStateStore(path.join(root, "state.json"));
    await store.put(
      createInstallationRecord({
        id: "sample-id",
        serverIdentifier: "sample-id",
        displayName: "Sample",
        client: "cursor",
        source: "registry",
        strategy: "ephemeral",
        configName: "sample",
        configPath,
        configScope: "user",
      }),
    );
    const findings = await inspectRecoveryState({
      adapters: [adapter],
      stateStore: store,
      journal,
      installRoot: path.join(root, "missing-installations"),
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: "confirmed_incomplete_configuration_transaction",
        status: "incomplete",
      }),
    );
    await expect(archiveOrphanedConfigBackup(adapter, journal)).rejects.toThrow(
      /orphaned backup/i,
    );
    expect(await readFile(configBackupPath(configPath))).toEqual(original);
    expect(await readFile(configPath)).toEqual(active);

    const actions = await recoverPendingOperations({
      adapters: [adapter],
      stateStore: store,
      journal,
      installRoot: path.join(root, "missing-installations"),
    });
    expect(actions).toContainEqual(
      expect.objectContaining({
        operationId: operation.id,
        status: "reconciled",
      }),
    );
    expect(await readFile(configBackupPath(configPath))).toEqual(original);
    expect(await archiveOrphanedConfigBackup(adapter, journal)).toMatchObject({
      status: "reconciled",
    });
    expect(await readFile(configPath)).toEqual(active);
  });

  it("classifies a backup with a possibly associated pending operation as ambiguous", async () => {
    const root = await temporaryDirectory("mcpget-recovery-ambiguous-");
    const configPath = path.join(root, "client.json");
    const original = '{"mcpServers":{"sample":{"command":"node"}}}\n';
    await writeFile(configPath, original);
    const journal = new OperationJournal(path.join(root, "operations"));
    await journal.begin({
      kind: "install",
      client: "cursor",
      configPath,
      configName: "sample",
      serverIdentifier: "sample-id",
    });
    const backupPath = configBackupPath(configPath);
    await writeFile(backupPath, original, { mode: 0o600 });
    const adapter = new JsonClientAdapter("cursor", "Cursor", configPath);
    const findings = await inspectRecoveryState({
      adapters: [adapter],
      stateStore: new InstallationStateStore(path.join(root, "state.json")),
      journal,
      installRoot: path.join(root, "missing-installations"),
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: "ambiguous_configuration_backup",
        status: "ambiguous",
        path: backupPath,
      }),
    );
    await expect(archiveOrphanedConfigBackup(adapter, journal)).rejects.toThrow(
      /orphaned backup/i,
    );
    expect(await readFile(backupPath, "utf8")).toBe(original);
  });

  it("reports an interrupted archive attempt and serializes concurrent resolutions", async () => {
    const root = await temporaryDirectory("mcpget-recovery-archive-race-");
    const configPath = path.join(root, "client.json");
    const backupPath = configBackupPath(configPath);
    const active =
      '{"mcpServers":{"sample":{"command":"node","args":["new"]}}}\n';
    const original =
      '{"mcpServers":{"sample":{"command":"node","args":["old"]}}}\n';
    await writeFile(configPath, active);
    await writeFile(backupPath, original, { mode: 0o600 });
    const journal = new OperationJournal(path.join(root, "operations"));
    await journal.beginBackupResolution({
      client: "cursor",
      configPath,
      backupPath,
      archivePath: `${backupPath}.interrupted`,
      backupSha256: sha256(Buffer.from(original)),
      activeSha256: sha256(Buffer.from(active)),
    });
    const adapter = new JsonClientAdapter("cursor", "Cursor", configPath);
    const findings = await inspectRecoveryState({
      adapters: [adapter],
      stateStore: new InstallationStateStore(path.join(root, "state.json")),
      journal,
      installRoot: path.join(root, "missing-installations"),
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: "interrupted_backup_resolution",
        status: "incomplete",
        path: backupPath,
        relatedPath: `${backupPath}.interrupted`,
      }),
    );
    await expect(archiveOrphanedConfigBackup(adapter, journal)).rejects.toThrow(
      /previous backup archival operation was interrupted/i,
    );
    await journal.finishBackupResolution(
      (await journal.listBackupResolutions())[0]!.id,
      "failed",
    );

    const concurrent = await Promise.allSettled([
      archiveOrphanedConfigBackup(adapter, journal),
      archiveOrphanedConfigBackup(adapter, journal),
    ]);
    expect(
      concurrent.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(2);
    const completed = (await journal.listBackupResolutions()).filter(
      (resolution) => resolution.status === "completed",
    );
    expect(completed).toHaveLength(1);
    expect(await readFile(completed[0]!.archivePath, "utf8")).toBe(original);
    expect(await readFile(configPath, "utf8")).toBe(active);
  });

  it("serializes backup archival against a configuration mutation", async () => {
    const root = await temporaryDirectory("mcpget-recovery-archive-mutation-");
    const configPath = path.join(root, "client.json");
    const backupPath = configBackupPath(configPath);
    const active =
      '{"theme":"keep","mcpServers":{"sample":{"command":"node","args":["new"]}}}\n';
    const original =
      '{"theme":"old","mcpServers":{"sample":{"command":"node","args":["old"]}}}\n';
    await writeFile(configPath, active);
    await writeFile(backupPath, original, { mode: 0o600 });
    const journal = new OperationJournal(path.join(root, "operations"));
    const adapter = new JsonClientAdapter(
      "cursor",
      "Cursor",
      configPath,
      journal,
    );

    const results = await Promise.allSettled([
      archiveOrphanedConfigBackup(adapter, journal),
      adapter.add({ name: "new", command: "node", args: ["server.js"] }),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    expect(await adapter.read()).toHaveProperty("new");

    const resolution = (await journal.listBackupResolutions())[0]!;
    expect(resolution.status).toBe("completed");
    expect(await readFile(resolution.archivePath, "utf8")).toBe(original);
    expect(await readFile(configPath, "utf8")).not.toContain("old.js");
    await expect(readFile(backupPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await journal.listBackupResolutions()).toHaveLength(1);
  });

  it.each(["claude", "cursor", "codex"] as const)(
    "automatically archives a validated stale %s backup before unrelated removal",
    async (client) => {
      const root = await temporaryDirectory(`mcpget-${client}-lifecycle-`);
      const configPath = path.join(
        root,
        client === "codex" ? "config.toml" : "config.json",
      );
      const journal = new OperationJournal(path.join(root, "operations"));
      let configAdapter: JsonClientAdapter | CodexAdapter;

      if (client === "codex") {
        await writeFile(
          configPath,
          [
            'model = "active"',
            "",
            "[mcp_servers.remove_me]",
            'command = "node"',
            'args = ["server.js"]',
            "",
            "[mcp_servers.keep_me]",
            'command = "python"',
            'args = ["other.py"]',
            "",
          ].join("\n"),
        );
        await writeFile(
          configBackupPath(configPath),
          [
            'model = "old"',
            "",
            "[mcp_servers.remove_me]",
            'command = "node"',
            'args = ["old.js"]',
            "",
          ].join("\n"),
          { mode: 0o600 },
        );
        configAdapter = new CodexAdapter(configPath, undefined, journal);
      } else {
        await writeFile(
          configPath,
          JSON.stringify({
            theme: "active",
            mcpServers: {
              remove_me: { command: "node", args: ["server.js"] },
              keep_me: { command: "python", args: ["other.py"] },
            },
          }),
        );
        await writeFile(
          configBackupPath(configPath),
          JSON.stringify({
            theme: "old",
            mcpServers: {
              remove_me: { command: "node", args: ["old.js"] },
            },
          }),
          { mode: 0o600 },
        );
        configAdapter = new JsonClientAdapter(
          client,
          client === "claude" ? "Claude Desktop" : "Cursor",
          configPath,
          journal,
        );
      }

      await expect(configAdapter.remove("remove_me")).resolves.toBe(true);
      await expect(
        readFile(configBackupPath(configPath)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await journal.listBackupResolutions()).toHaveLength(1);
      const remaining = await configAdapter.read();
      expect(remaining).toHaveProperty("keep_me");
      expect(remaining).not.toHaveProperty("remove_me");
    },
  );

  it("reconciles a provable metadata-less operation before archiving its backup", async () => {
    const root = await temporaryDirectory("mcpget-recovery-reconcile-backup-");
    const configPath = path.join(root, "client.json");
    const backupPath = configBackupPath(configPath);
    const active = Buffer.from(
      '{"mcpServers":{"sample":{"command":"node","args":["new.js"]}}}\n',
    );
    const original = Buffer.from(
      '{"mcpServers":{"sample":{"command":"node","args":["old.js"]}}}\n',
    );
    const journal = new OperationJournal(path.join(root, "operations"));
    const store = new InstallationStateStore(path.join(root, "state.json"));
    const client = new JsonClientAdapter(
      "cursor",
      "Cursor",
      configPath,
      journal,
    );
    const operation = await journal.begin({
      kind: "install",
      client: "cursor",
      configPath,
      configName: "sample",
      serverIdentifier: "sample-id",
    });
    await writeFile(configPath, active);
    await writeFile(backupPath, original, { mode: 0o600 });
    await store.put(
      createInstallationRecord({
        id: "sample-id",
        serverIdentifier: "sample-id",
        displayName: "Sample",
        client: "cursor",
        source: "registry",
        strategy: "ephemeral",
        configName: "sample",
        configPath,
        configScope: "user",
      }),
    );

    await ensureConfigBackupLifecycle(
      configPath,
      "cursor",
      async (candidatePath) => {
        await new JsonClientAdapter("cursor", "Cursor", candidatePath).read();
      },
      journal,
      undefined,
      () =>
        recoverPendingOperations({
          adapters: [client],
          stateStore: store,
          journal,
          configPath,
          allowMetadataLessBackupReconciliation: true,
          skipPackageCleanup: true,
        }),
    );

    expect(await journal.list()).toEqual([]);
    await expect(readFile(backupPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(configPath)).toEqual(active);
    const resolution = (await journal.listBackupResolutions())[0]!;
    expect(resolution.status).toBe("completed");
    expect(await readFile(resolution.archivePath)).toEqual(original);
    expect(operation.configPath).toBe(configPath);
  });

  it("confirms rollback and cleans an in-progress backup only after operation reconciliation", async () => {
    const root = await temporaryDirectory("mcpget-recovery-in-progress-");
    const configPath = path.join(root, "client.json");
    const active = Buffer.from(
      '{"mcpServers":{"sample":{"command":"node","args":["server.js"]}}}\n',
    );
    const journal = new OperationJournal(path.join(root, "operations"));
    const store = new InstallationStateStore(path.join(root, "state.json"));
    const client = new JsonClientAdapter(
      "cursor",
      "Cursor",
      configPath,
      journal,
    );
    await writeFile(configPath, active);
    const operation = await journal.begin({
      kind: "install",
      client: "cursor",
      configPath,
      configName: "sample",
      serverIdentifier: "sample-id",
    });
    await createConfigBackup(configPath, active, {
      operationId: operation.id,
      operationKind: "install",
    });
    await store.put(
      createInstallationRecord({
        id: "sample-id",
        serverIdentifier: "sample-id",
        displayName: "Sample",
        client: "cursor",
        source: "registry",
        strategy: "ephemeral",
        configName: "sample",
        configPath,
        configScope: "user",
      }),
    );

    await ensureConfigBackupLifecycle(
      configPath,
      "cursor",
      async (candidatePath) => {
        await new JsonClientAdapter("cursor", "Cursor", candidatePath).read();
      },
      journal,
      undefined,
      () =>
        recoverPendingOperations({
          adapters: [client],
          stateStore: store,
          journal,
          configPath,
          allowMetadataLessBackupReconciliation: true,
          skipPackageCleanup: true,
        }),
    );

    expect(await journal.list()).toEqual([]);
    await expect(readFile(configBackupPath(configPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(configPath)).toEqual(active);
    await expect(
      readFile(`${configBackupPath(configPath)}.meta.json`),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await journal.listBackupResolutions()).toHaveLength(0);
  });

  it("does not infer completion of an in-progress transaction from matching files alone", async () => {
    const root = await temporaryDirectory("mcpget-recovery-no-outcome-");
    const configPath = path.join(root, "client.json");
    const active = Buffer.from('{"mcpServers":{}}\n');
    const journal = new OperationJournal(path.join(root, "operations"));
    await writeFile(configPath, active);
    await createConfigBackup(configPath, active);

    await expect(
      ensureConfigBackupLifecycle(
        configPath,
        "cursor",
        async (candidatePath) => {
          await new JsonClientAdapter("cursor", "Cursor", candidatePath).read();
        },
        journal,
      ),
    ).rejects.toThrow(/has no confirmed outcome/i);
    expect(await readFile(configBackupPath(configPath))).toEqual(active);
  });

  it("reconciles an installed configuration without claiming connection or authentication", async () => {
    const root = await temporaryDirectory("mcpget-recovery-install-");
    const configPath = path.join(root, "config.json");
    const entries: Record<string, ServerConfiguration> = {
      sample: {
        name: "sample",
        command: "node",
        args: ["server.js"],
      },
    };
    const client = adapter(configPath, entries);
    const store = new InstallationStateStore(path.join(root, "state.json"));
    const journal = new OperationJournal(path.join(root, "operations"));
    const record = createInstallationRecord({
      id: "sample-id",
      serverIdentifier: "sample-id",
      displayName: "Sample",
      client: "codex",
      source: "registry",
      strategy: "ephemeral",
      configName: "sample",
      configPath,
      configScope: "user",
    });
    await store.put(record);
    await journal.begin({
      kind: "install",
      client: "codex",
      configPath,
      configName: "sample",
      serverIdentifier: "sample-id",
    });

    const actions = await recoverPendingOperations({
      adapters: [client],
      stateStore: store,
      journal,
    });

    const recovered = await store.get("sample-id", "codex");
    expect(actions[0]?.status).toBe("reconciled");
    expect(recovered?.states.configured.status).toBe("completed");
    expect(recovered?.states.connection_verified.status).toBe("not_verified");
    expect(recovered?.states.authenticated.status).toBe("not_verified");
    expect(await journal.list()).toEqual([]);
  });

  it("removes stale state after a completed removal while preserving the configuration boundary", async () => {
    const root = await temporaryDirectory("mcpget-recovery-remove-");
    const configPath = path.join(root, "config.json");
    const client = adapter(configPath, {});
    const store = new InstallationStateStore(path.join(root, "state.json"));
    const journal = new OperationJournal(path.join(root, "operations"));
    const record = createInstallationRecord({
      id: "sample-id",
      serverIdentifier: "sample-id",
      displayName: "Sample",
      client: "codex",
      source: "registry",
      strategy: "ephemeral",
      configName: "sample",
      configPath,
      configScope: "user",
    });
    await store.put(record);
    await journal.begin({
      kind: "remove",
      client: "codex",
      configPath,
      configName: "sample",
      serverIdentifier: "sample-id",
    });

    const actions = await recoverPendingOperations({
      adapters: [client],
      stateStore: store,
      journal,
    });

    expect(actions[0]?.status).toBe("reconciled");
    expect(await store.get("sample-id", "codex")).toBeUndefined();
    expect(await journal.list()).toEqual([]);
    expect(await client.read()).toEqual({});
  });
});

describe("managed package metadata recovery safety", () => {
  it("preserves unknown metadata fields when adding a server association", async () => {
    const root = await temporaryDirectory("mcpget-metadata-valid-");
    const directory = managedInstallPath("@example/server", undefined, root);
    await mkdir(directory, { recursive: true });
    const metadataPath = path.join(directory, "mcpget-installation.json");
    await writeFile(
      metadataPath,
      `${JSON.stringify({
        schemaVersion: 1,
        packageIdentifier: "@example/server",
        installedVersion: "1.2.3",
        installationType: "npm",
        installationLocation: directory,
        installedAt: new Date().toISOString(),
        servers: [],
        futureField: { keep: true },
      })}\n`,
    );

    await updateManagedMetadata(
      {
        directory,
        packageIdentifier: "@example/server",
        installedVersion: "1.2.3",
        command: "node",
        args: [],
        reused: true,
        lifecycleScriptsEnabled: false,
      },
      {
        serverIdentifier: "sample-id",
        serverName: "Sample",
        client: "codex",
        configurationEntry: "sample",
        verificationStatus: "not_verified",
      },
    );

    const updated = JSON.parse(await readFile(metadataPath, "utf8")) as {
      futureField: { keep: boolean };
      servers: unknown[];
    };
    expect(updated.futureField).toEqual({ keep: true });
    expect(updated.servers).toHaveLength(1);
  });

  it("leaves malformed metadata unchanged and reports it as invalid", async () => {
    const root = await temporaryDirectory("mcpget-metadata-invalid-");
    const directory = managedInstallPath("@example/server", undefined, root);
    await mkdir(directory, { recursive: true });
    const metadataPath = path.join(directory, "mcpget-installation.json");
    const malformed = "{ not valid json";
    await writeFile(metadataPath, malformed);

    await expect(readManagedPackageMetadata(directory)).rejects.toThrow(
      /malformed/,
    );
    expect(await inspectManagedPackages(root)).toMatchObject([
      { directory, status: "metadata_invalid" },
    ]);
    expect(await readFile(metadataPath, "utf8")).toBe(malformed);
  });

  it("does not delete a package when the requested server association is absent", async () => {
    const root = await temporaryDirectory("mcpget-metadata-release-");
    const directory = managedInstallPath("@example/server", undefined, root);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "mcpget-installation.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        packageIdentifier: "@example/server",
        installedVersion: "1.2.3",
        installationType: "npm",
        installationLocation: directory,
        installedAt: new Date().toISOString(),
        servers: [],
      })}\n`,
    );

    await expect(
      releaseManagedAssociation(directory, "missing", "codex", "missing", root),
    ).resolves.toBe(false);
    expect(await readdir(directory)).toContain("mcpget-installation.json");
  });

  it("deletes an orphan only after rechecking supported-client references", async () => {
    const root = await temporaryDirectory("mcpget-metadata-orphan-");
    const directory = managedInstallPath("@example/server", undefined, root);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "mcpget-installation.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        packageIdentifier: "@example/server",
        installedVersion: "1.2.3",
        installationType: "npm",
        installationLocation: directory,
        installedAt: new Date().toISOString(),
        servers: [],
      })}\n`,
    );
    const entries: Record<string, ServerConfiguration> = {
      external: {
        name: "external",
        command: "node",
        args: [path.join(directory, "node_modules", "server.js")],
      },
    };
    const client = adapter(path.join(root, "client-config.json"), entries);
    await writeFile(client.configPath(), "{}");

    await expect(
      cleanupOrphanedManagedPackage(directory, root, [client]),
    ).resolves.toBe(false);
    expect(await readdir(directory)).toContain("mcpget-installation.json");

    delete entries.external;
    await writeFile(client.configPath(), JSON.stringify({ cwd: directory }));
    await expect(
      cleanupOrphanedManagedPackage(directory, root, [client]),
    ).resolves.toBe(false);
    await writeFile(client.configPath(), "{}");
    await expect(
      cleanupOrphanedManagedPackage(directory, root, [client]),
    ).resolves.toBe(true);
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans a validated orphan only through the explicit recovery workflow", async () => {
    const root = await temporaryDirectory("mcpget-recovery-orphan-");
    const directory = managedInstallPath("@example/server", undefined, root);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "mcpget-installation.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        packageIdentifier: "@example/server",
        installedVersion: "1.2.3",
        installationType: "npm",
        installationLocation: directory,
        installedAt: new Date().toISOString(),
        servers: [],
      })}\n`,
    );
    const configPath = path.join(root, "client-config.json");
    await writeFile(configPath, "{}");
    const actions = await recoverPendingOperations({
      adapters: [adapter(configPath, {})],
      stateStore: new InstallationStateStore(path.join(root, "state.json")),
      journal: new OperationJournal(path.join(root, "operations")),
      installRoot: root,
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.detail).toContain("validated orphaned managed package");
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
