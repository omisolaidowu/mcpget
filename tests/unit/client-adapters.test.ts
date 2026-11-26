import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeJsonSafely } from "../../src/installers/atomic-config.js";
import {
  CodexAdapter,
  codexConfigPath,
} from "../../src/installers/codex-adapter.js";
import {
  JsonClientAdapter,
  resolveClaudeConfigPath,
  resolveCursorConfigPath,
} from "../../src/installers/json-client-adapter.js";
import { configBackupMetadataPath } from "../../src/installers/config-backup.js";
import { createInstallPlan } from "../../src/installers/plan-installer.js";
import type { ServerCandidate } from "../../src/models/server-candidate.js";
import type { ServerConfiguration } from "../../src/installers/types.js";

function candidate(): ServerCandidate {
  return {
    name: "thunderbit",
    title: "Thunderbit MCP Server",
    registryIdentifier: "io.example/thunderbit",
    operational: {
      deploymentModels: ["Local package"],
      transports: ["stdio"],
      packages: [
        {
          registryType: "npm",
          identifier: "@thunderbit/mcp-server",
          version: "1.0.4",
        },
      ],
      remoteEndpoints: [],
      configurationInputs: [],
      authentication: "Unknown",
      clientCompatibility: "Unknown",
      setupComplexity: "Unknown",
    },
    sourceRegistry: "test",
    sourceRecordUrl: "test",
  };
}

function codexConfigText(
  base: string,
  servers: Map<string, ServerConfiguration>,
): string {
  const entries = [...servers.values()].map((server) => {
    const section = `[mcp_servers.${JSON.stringify(server.name)}]`;
    if (server.url) return `${section}\nurl = ${JSON.stringify(server.url)}\n`;
    return [
      section,
      `command = ${JSON.stringify(server.command ?? "")}`,
      `args = ${JSON.stringify(server.args ?? [])}`,
      ...(server.env
        ? [
            `env = { ${Object.entries(server.env)
              .map(
                ([key, value]) =>
                  `${JSON.stringify(key)} = ${JSON.stringify(value)}`,
              )
              .join(", ")} }`,
          ]
        : []),
      "",
    ].join("\n");
  });
  return `${base.trimEnd()}\n${entries.length ? `\n${entries.join("\n")}` : ""}`;
}

describe("JSON client configuration paths and persisted verification", () => {
  it.each(["claude", "cursor"] as const)(
    "writes required and preserved environment values for %s",
    async (client) => {
      const dir = await mkdtemp(path.join(tmpdir(), `mcpget-${client}-env-`));
      const configPath = path.join(dir, "client.json");
      try {
        await writeFile(
          configPath,
          JSON.stringify({
            mcpServers: {
              notion: {
                command: process.execPath,
                args: ["server.js"],
                env: { EXISTING: "keep", NOTION_TOKEN: "old-secret" },
              },
            },
          }),
        );
        const adapter = new JsonClientAdapter(client, client, configPath);
        const entry = {
          name: "notion",
          command: process.execPath,
          args: ["server.js"],
          env: { EXISTING: "keep", NOTION_TOKEN: "new-secret" },
        };
        await adapter.add(entry);
        expect(await adapter.verify(entry)).toMatchObject({ verified: true });
        const written = JSON.parse(await readFile(configPath, "utf8")) as {
          mcpServers: Record<string, { env: Record<string, string> }>;
        };
        expect(written.mcpServers.notion?.env).toEqual({
          EXISTING: "keep",
          NOTION_TOKEN: "new-secret",
        });
        const withoutCredential = { ...entry, env: { EXISTING: "keep" } };
        await adapter.add(withoutCredential);
        const replaced = JSON.parse(await readFile(configPath, "utf8")) as {
          mcpServers: Record<string, { env: Record<string, string> }>;
        };
        expect(replaced.mcpServers.notion?.env).toEqual({ EXISTING: "keep" });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("selects the active Windows Claude Desktop profile and its user scope", () => {
    const path = resolveClaudeConfigPath({
      platform: "win32",
      home: "C:\\Users\\test",
      appData: "C:\\Users\\test\\AppData\\Roaming",
      localAppData: "C:\\Users\\test\\AppData\\Local",
      claudeProfiles: ["claude_pzs8sxrjxfjjc"],
    });
    expect(path).toBe(
      "C:\\Users\\test\\AppData\\Local\\Claude-Data\\claude_pzs8sxrjxfjjc\\claude_desktop_config.json",
    );
  });

  it("uses documented Claude and Cursor user paths across Windows, macOS, and Linux", () => {
    expect(
      resolveClaudeConfigPath({
        platform: "win32",
        home: "C:\\Users\\test",
        appData: "C:\\Users\\test\\Roaming",
        claudeProfiles: [],
      }),
    ).toBe("C:\\Users\\test\\Roaming\\Claude\\claude_desktop_config.json");
    expect(
      resolveClaudeConfigPath({ platform: "darwin", home: "/Users/test" }),
    ).toBe(
      "/Users/test/Library/Application Support/Claude/claude_desktop_config.json",
    );
    expect(
      resolveClaudeConfigPath({
        platform: "linux",
        home: "/home/test",
        xdgConfigHome: "/home/test/.config",
      }),
    ).toBe("/home/test/.config/Claude/claude_desktop_config.json");
    expect(
      resolveCursorConfigPath({ platform: "win32", home: "C:\\Users\\test" }),
    ).toBe("C:\\Users\\test\\.cursor\\mcp.json");
    expect(
      resolveCursorConfigPath({ platform: "darwin", home: "/Users/test" }),
    ).toBe("/Users/test/.cursor/mcp.json");
    expect(
      resolveCursorConfigPath({ platform: "linux", home: "/home/test" }),
    ).toBe("/home/test/.cursor/mcp.json");
  });

  it("creates a normalized Claude server entry pointing at the managed executable and verifies it from disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcpget-claude-"));
    const configPath = path.join(dir, "Claude", "claude_desktop_config.json");
    const executable = path.join(
      dir,
      "MCPGet",
      "installations",
      "package",
      "node_modules",
      "@thunderbit",
      "mcp-server",
      "bin",
      "cli.js",
    );
    try {
      const plan = createInstallPlan(candidate());
      expect(plan.entry.name).toBe("thunderbit-mcp-server");
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(path.dirname(executable), { recursive: true }),
      );
      await writeFile(executable, "// managed executable");
      const adapter = new JsonClientAdapter(
        "claude",
        "Claude Desktop",
        configPath,
      );
      const entry: ServerConfiguration = {
        ...plan.entry,
        command: process.execPath,
        args: [executable],
      };
      await adapter.add(entry);
      expect(adapter.configScope()).toBe("user");
      expect(adapter.configPath()).toBe(configPath);
      expect(await adapter.verify(entry)).toEqual({
        verified: true,
        detail: `Exact server entry re-read from ${configPath} in user scope.`,
      });
      const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
        mcpServers: Record<string, { command: string; args: string[] }>;
      };
      expect(persisted.mcpServers[entry.name]).toEqual({
        command: process.execPath,
        args: [executable],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves unrelated configuration and servers while safely updating an existing server", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcpget-json-update-"));
    const file = path.join(dir, "claude_desktop_config.json");
    try {
      await writeFile(
        file,
        JSON.stringify({
          theme: "dark",
          unrelated: { keep: true },
          mcpServers: {
            other: { command: "other", args: [] },
            thunderbit: { command: "npx", args: ["old"] },
          },
        }),
      );
      const adapter = new JsonClientAdapter("claude", "Claude Desktop", file);
      const desired = {
        name: "thunderbit",
        command: process.execPath,
        args: ["C:\\Managed\\server.js"],
      };
      await adapter.add(desired);
      const persisted = JSON.parse(await readFile(file, "utf8")) as {
        theme: string;
        unrelated: unknown;
        mcpServers: Record<string, unknown>;
      };
      expect(persisted.theme).toBe("dark");
      expect(persisted.unrelated).toEqual({ keep: true });
      expect(persisted.mcpServers.other).toEqual({
        command: "other",
        args: [],
      });
      expect(persisted.mcpServers.thunderbit).toEqual({
        command: process.execPath,
        args: ["C:\\Managed\\server.js"],
      });
      expect(await adapter.verify(desired)).toMatchObject({ verified: true });
      await expect(readFile(`${file}.mcpget.bak`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await adapter.remove("thunderbit")).toBe(true);
      expect(await adapter.verifyRemoved("thunderbit")).toBe(true);
      await expect(readFile(`${file}.mcpget.bak`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a private rollback backup through verification and removes it on commit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcpget-json-backup-"));
    const configPath = path.join(dir, "client.json");
    const backupPath = `${configPath}.mcpget.bak`;
    const secret = "old-credential-value";
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            existing: {
              command: "node",
              args: ["old.js"],
              env: { TOKEN: secret },
            },
          },
        }),
      );
      const adapter = new JsonClientAdapter("claude", "Claude", configPath);
      const verify = adapter.verify.bind(adapter);
      const verification = vi
        .spyOn(adapter, "verify")
        .mockImplementation(async (entry) => {
          expect(await readFile(backupPath, "utf8")).toContain(secret);
          if (process.platform !== "win32") {
            const permissions = (await stat(backupPath)).mode & 0o777;
            expect(permissions & 0o077).toBe(0);
          }
          return verify(entry);
        });

      await adapter.add({
        name: "existing",
        command: process.execPath,
        args: ["new.js"],
      });

      expect(verification).toHaveBeenCalledOnce();
      await expect(readFile(backupPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("restores JSON config on verification failure and retains no committed backup", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcpget-json-rollback-"));
    const configPath = path.join(dir, "client.json");
    const original =
      '{"theme":"keep","mcpServers":{"old":{"command":"node"}}}\n';
    try {
      await writeFile(configPath, original);
      const adapter = new JsonClientAdapter("cursor", "Cursor", configPath);
      vi.spyOn(adapter, "verify").mockResolvedValue({
        verified: false,
        detail: "Synthetic verification failure.",
      });

      await expect(
        adapter.add({ name: "new", command: "node", args: ["server.js"] }),
      ).rejects.toThrow(/rolled back/);
      expect(await readFile(configPath, "utf8")).toBe(original);
      await expect(readFile(`${configPath}.mcpget.bak`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(configBackupMetadataPath(configPath)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks writes and preserves backup artifacts left by an interrupted transaction", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcpget-json-interrupted-"));
    const configPath = path.join(dir, "client.json");
    const original = '{"mcpServers":{"old":{"command":"node"}}}\n';
    try {
      await writeFile(configPath, original);
      await writeJsonSafely(configPath, {
        mcpServers: { old: { command: "node" }, pending: { command: "node" } },
      });
      expect(await readFile(`${configPath}.mcpget.bak`, "utf8")).toBe(original);
      const abandonedBackup = `${configPath}.mcpget.bak.123.interrupted.tmp`;
      await writeFile(abandonedBackup, "temporary previous credentials", {
        mode: 0o600,
      });

      const adapter = new JsonClientAdapter("cursor", "Cursor", configPath);
      await expect(
        adapter.add({
          name: "new",
          command: process.execPath,
          args: ["server.js"],
        }),
      ).rejects.toThrow(/unresolved configuration backup artifacts/i);
      expect(await readFile(`${configPath}.mcpget.bak`, "utf8")).toBe(original);
      expect(await readFile(abandonedBackup, "utf8")).toBe(
        "temporary previous credentials",
      );
      expect(await readFile(configPath, "utf8")).toContain('"pending"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails before writing when the original cannot be read or a backup is unresolved", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcpget-json-backup-fail-"));
    const blocker = path.join(dir, "not-a-directory");
    const configPath = path.join(dir, "existing.json");
    const original = '{"mcpServers":{"old":{"command":"node"}}}\n';
    try {
      await writeFile(blocker, "block");
      const unreadable = new JsonClientAdapter(
        "claude",
        "Claude",
        path.join(blocker, "config.json"),
      );
      await expect(
        unreadable.add({ name: "new", command: "node", args: [] }),
      ).rejects.toThrow();
      expect(await readFile(blocker, "utf8")).toBe("block");

      await writeFile(configPath, original);
      const backupPath = `${configPath}.mcpget.bak`;
      await writeFile(backupPath, "ambiguous backup", { mode: 0o600 });
      const adapter = new JsonClientAdapter("cursor", "Cursor", configPath);
      await expect(
        adapter.add({ name: "new", command: "node", args: [] }),
      ).rejects.toThrow(/configuration at .* is not valid JSON/i);
      expect(await readFile(configPath, "utf8")).toBe(original);
      expect(await readFile(backupPath, "utf8")).toBe("ambiguous backup");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retains the original backup when post-write rollback cannot be confirmed", async () => {
    const dir = await mkdtemp(
      path.join(tmpdir(), "mcpget-json-rollback-fail-"),
    );
    const configPath = path.join(dir, "client.json");
    const original = '{"mcpServers":{"old":{"command":"node"}}}\n';
    try {
      await writeFile(configPath, original);
      const adapter = new JsonClientAdapter("cursor", "Cursor", configPath);
      vi.spyOn(adapter, "verify").mockImplementation(async () => {
        await unlink(configPath);
        await mkdir(configPath);
        return { verified: false, detail: "Synthetic verification failure." };
      });

      await expect(
        adapter.add({ name: "new", command: "node", args: ["server.js"] }),
      ).rejects.toThrow(/rollback could not be confirmed/i);
      expect(await readFile(`${configPath}.mcpget.bak`, "utf8")).toBe(original);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not claim success when the config target is unwritable and rejects invalid JSON safely", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcpget-json-failure-"));
    const blocker = path.join(dir, "not-a-directory");
    try {
      await writeFile(blocker, "block");
      const blocked = new JsonClientAdapter(
        "claude",
        "Claude Desktop",
        path.join(blocker, "config.json"),
      );
      await expect(
        blocked.add({
          name: "mcp",
          command: process.execPath,
          args: ["server.js"],
        }),
      ).rejects.toThrow();
      expect(
        (
          await blocked.verify({
            name: "mcp",
            command: process.execPath,
            args: ["server.js"],
          })
        ).verified,
      ).toBe(false);
      const invalidPath = path.join(dir, "invalid.json");
      await writeFile(invalidPath, "{invalid");
      const invalid = new JsonClientAdapter(
        "claude",
        "Claude Desktop",
        invalidPath,
      );
      await expect(
        invalid.add({ name: "mcp", command: process.execPath, args: [] }),
      ).rejects.toThrow(/not valid JSON/i);
      expect(await readFile(invalidPath, "utf8")).toBe("{invalid");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Codex user-scope configuration", () => {
  it("honors CODEX_HOME and uses the explicit user config scope", () => {
    expect(codexConfigPath("C:\\Users\\test\\.codex-alt")).toBe(
      path.join("C:\\Users\\test\\.codex-alt", "config.toml"),
    );
    expect(codexConfigPath("/Users/test/.codex-alt", "darwin")).toBe(
      "/Users/test/.codex-alt/config.toml",
    );
    expect(codexConfigPath("/home/test/.codex-alt", "linux")).toBe(
      "/home/test/.codex-alt/config.toml",
    );
    const adapter = new CodexAdapter(
      "C:\\Users\\test\\.codex-alt\\config.toml",
    );
    expect(adapter.configScope()).toBe("user");
  });

  it("reads Codex TOML without invoking the Codex CLI", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcpget-codex-read-"));
    const configPath = path.join(dir, "config.toml");
    const runner = async (): Promise<string | undefined> => {
      throw new Error("Codex CLI should not be needed to read config.");
    };
    try {
      await writeFile(
        configPath,
        [
          'model = "preserve-me"',
          "",
          '[mcp_servers."thunderbit.mcp"]',
          'command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"',
          'args = ["server.js", "--flag"]',
          'env = { API_KEY = "hidden-value", EXISTING = "keep" }',
          "",
          "[mcp_servers.remote]",
          'url = "https://example.test/mcp"',
          "",
        ].join("\n"),
      );
      const adapter = new CodexAdapter(configPath, runner);
      await expect(adapter.read()).resolves.toEqual({
        "thunderbit.mcp": {
          name: "thunderbit.mcp",
          command: "C:\\Program Files\\nodejs\\node.exe",
          args: ["server.js", "--flag"],
          env: { API_KEY: "hidden-value", EXISTING: "keep" },
        },
        remote: {
          name: "remote",
          url: "https://example.test/mcp",
          transport: "streamable_http",
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes missing, malformed, inaccessible, and unsupported Codex configuration", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcpget-codex-read-errors-"));
    try {
      const missing = new CodexAdapter(path.join(dir, "missing.toml"));
      await expect(missing.read()).rejects.toThrow(/configuration is missing/i);

      const malformedPath = path.join(dir, "malformed.toml");
      await writeFile(malformedPath, "[mcp_servers.\n");
      await expect(new CodexAdapter(malformedPath).read()).rejects.toThrow(
        /malformed TOML/i,
      );

      const blocker = path.join(dir, "not-a-directory");
      await writeFile(blocker, "file");
      await expect(
        new CodexAdapter(path.join(blocker, "config.toml")).read(),
      ).rejects.toThrow(/configuration is inaccessible/i);

      const unsupportedPath = path.join(dir, "unsupported.toml");
      await writeFile(unsupportedPath, "mcp_servers = []\n");
      await expect(new CodexAdapter(unsupportedPath).read()).rejects.toThrow(
        /unsupported mcp_servers schema/i,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes, verifies, updates, and removes Codex TOML without invoking Codex CLI", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcpget-codex-adapter-"));
    const configPath = path.join(dir, "config.toml");
    const servers = new Map<string, ServerConfiguration>();
    const runner = async (): Promise<string | undefined> => {
      throw new Error(
        "Codex CLI must not be invoked for configuration management.",
      );
    };
    try {
      servers.set("unrelated", {
        name: "unrelated",
        command: "python",
        args: ["other.py"],
        env: { KEEP: "yes" },
      });
      servers.set("thunderbit", {
        name: "thunderbit",
        command: process.execPath,
        args: ["old.js"],
        env: { KEEP: "yes", API_KEY: "old-secret" },
      });
      await writeFile(
        configPath,
        codexConfigText(
          'model = "preserve-me"\n[profiles.work]\nmodel = "gpt-5"\n',
          servers,
        ),
      );
      const adapter = new CodexAdapter(configPath, runner);
      const entry = {
        name: "thunderbit",
        command: process.execPath,
        args: ["C:\\MCPGet\\server.js", "--flag"],
      };
      await adapter.add(entry);
      const effectiveEntry = {
        ...entry,
        env: { KEEP: "yes", API_KEY: "old-secret" },
      };
      expect(await adapter.verify(effectiveEntry)).toMatchObject({
        verified: true,
      });
      expect((await adapter.read()).thunderbit).toEqual(effectiveEntry);
      const persisted = await readFile(configPath, "utf8");
      expect(persisted).toContain('model = "preserve-me"');
      expect(persisted).toContain('model = "gpt-5"');
      expect((await adapter.read()).unrelated).toEqual({
        name: "unrelated",
        command: "python",
        args: ["other.py"],
        env: { KEEP: "yes" },
      });
      await expect(readFile(`${configPath}.mcpget.bak`)).rejects.toMatchObject({
        code: "ENOENT",
      });

      const firstWrite = persisted;
      await adapter.add(effectiveEntry);
      expect(await readFile(configPath, "utf8")).toBe(firstWrite);

      const updated = { ...entry, args: ["C:\\MCPGet\\replacement.js"] };
      await adapter.add(updated);
      expect(
        await adapter.verify({
          ...updated,
          env: { KEEP: "yes", API_KEY: "old-secret" },
        }),
      ).toMatchObject({ verified: true });
      expect(await adapter.remove("thunderbit")).toBe(true);
      expect(await adapter.verifyRemoved("thunderbit")).toBe(true);
      await expect(readFile(`${configPath}.mcpget.bak`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await adapter.remove("thunderbit")).toBe(false);
      expect(await adapter.read()).toEqual({
        unrelated: {
          name: "unrelated",
          command: "python",
          args: ["other.py"],
          env: { KEEP: "yes" },
        },
      });
      expect(await readFile(configPath, "utf8")).toContain(
        'model = "preserve-me"',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates a missing Codex config file and verifies remote URL entries without the CLI", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcpget-codex-create-"));
    const configPath = path.join(dir, "nested", "config.toml");
    const runner = async (): Promise<string | undefined> => {
      throw new Error("Codex CLI must not be invoked.");
    };
    try {
      const adapter = new CodexAdapter(configPath, runner);
      const entry = {
        name: "remote",
        url: "https://example.test/mcp",
        transport: "streamable_http",
      };
      await adapter.add(entry);
      expect(await adapter.verify(entry)).toMatchObject({ verified: true });
      expect((await adapter.read()).remote).toEqual(entry);
      await expect(readFile(`${configPath}.mcpget.bak`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rolls back a direct TOML write when independent verification fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcpget-codex-rollback-"));
    const configPath = path.join(dir, "config.toml");
    const original = 'model = "keep"\n';
    const secret = "never-print-this";
    try {
      await writeFile(configPath, original);
      const adapter = new CodexAdapter(configPath, async () => {
        throw new Error("Codex CLI must not be invoked.");
      });
      adapter.verify = async () => ({
        verified: false,
        detail: `Injected verification failure: ${secret}`,
      });
      const failure: unknown = await adapter
        .add({
          name: "missing",
          command: "node",
          args: ["server.js"],
          env: { API_KEY: secret },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      if (!(failure instanceof Error))
        throw new Error("Expected the simulated Codex TOML write to fail.");
      expect(failure.message).toContain("[REDACTED]");
      expect(failure.message).not.toContain(secret);
      expect(await readFile(configPath, "utf8")).toBe(original);
      await expect(readFile(`${configPath}.mcpget.bak`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes environment values into Codex TOML without invoking Codex CLI", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcpget-codex-env-"));
    const configPath = path.join(dir, "config.toml");
    const secretValue = 'test-secret-"value"\nline';
    const runner = async (): Promise<string | undefined> => {
      throw new Error("Codex CLI must not be invoked.");
    };
    try {
      await writeFile(configPath, 'model = "preserve-me"\n');
      const adapter = new CodexAdapter(configPath, runner);
      const entry = {
        name: "notion",
        command: process.execPath,
        args: ["server.js"],
        env: { EXISTING: "keep", NOTION_TOKEN: secretValue },
      };
      await adapter.add(entry);
      expect(await adapter.verify(entry)).toMatchObject({ verified: true });
      expect(await adapter.read()).toEqual({ notion: entry });
      const persistedConfig = await readFile(configPath, "utf8");
      expect(persistedConfig).toContain("NOTION_TOKEN");
      expect(persistedConfig).not.toContain(secretValue);
      expect(await adapter.read()).toEqual({ notion: entry });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves remote options and removes only the requested remote server", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcpget-codex-remote-"));
    const configPath = path.join(dir, "config.toml");
    try {
      await writeFile(
        configPath,
        [
          'model = "keep"',
          "",
          "[mcp_servers.existing_remote]",
          'url = "https://old.example.test/mcp"',
          'bearer_token_env_var = "REMOTE_TOKEN"',
          "",
        ].join("\n"),
      );
      const adapter = new CodexAdapter(configPath, async () => {
        throw new Error("Codex CLI must not be invoked.");
      });
      await adapter.add({
        name: "existing_remote",
        url: "https://new.example.test/mcp",
      });
      expect((await adapter.read()).existing_remote).toEqual({
        name: "existing_remote",
        url: "https://new.example.test/mcp",
        transport: "streamable_http",
      });
      expect(await readFile(configPath, "utf8")).toContain(
        'bearer_token_env_var = "REMOTE_TOKEN"',
      );
      expect(await adapter.remove("existing_remote")).toBe(true);
      expect(await readFile(configPath, "utf8")).toContain('model = "keep"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses the configuration file for Codex status detection", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcpget-codex-detect-"));
    const configPath = path.join(dir, "config.toml");
    try {
      await writeFile(configPath, 'model = "present"\n');
      const adapter = new CodexAdapter(configPath, async () => {
        throw new Error("Codex CLI must not be invoked.");
      });
      await expect(adapter.detect()).resolves.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
