import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonClientAdapter } from "../../src/installers/json-client-adapter.js";
import { createInstallPlan } from "../../src/installers/plan-installer.js";
import { CodexAdapter } from "../../src/installers/codex-adapter.js";
import {
  installManagedNpm,
  managedInstallRoot,
  npmInvocation,
  releaseManagedAssociation,
  updateManagedMetadata,
  validateNpmPackageIdentifier,
} from "../../src/installers/managed-npm.js";
import type { ServerCandidate } from "../../src/models/server-candidate.js";

function candidate(overrides: Partial<ServerCandidate> = {}): ServerCandidate {
  return {
    name: "io.example/notion",
    title: "Notion Tools",
    registryIdentifier: "io.example/notion",
    operational: {
      deploymentModels: ["Local package"],
      transports: ["stdio"],
      packages: [
        {
          registryType: "npm",
          identifier: "@example/notion-mcp",
          version: "1.2.0",
        },
      ],
      remoteEndpoints: [],
      configurationInputs: [],
      authentication: "Unknown",
      clientCompatibility: "Unknown",
      setupComplexity: "Unknown",
    },
    sourceRegistry: "Official MCP Registry",
    sourceRecordUrl: "https://registry.modelcontextprotocol.io/record",
    ...overrides,
  };
}

describe("installation planning and client config", () => {
  it("uses the Windows per-user local application data directory for managed packages", () => {
    expect(
      managedInstallRoot({
        platform: "win32",
        localAppData: "C:\\Users\\test\\AppData\\Local",
        env: {},
      }),
    ).toBe("C:\\Users\\test\\AppData\\Local\\MCPGet\\installations");
  });
  it("uses the Linux per-user shared data directory for managed packages", () => {
    expect(
      managedInstallRoot({
        platform: "linux",
        home: "/home/test",
        env: {},
      }),
    ).toBe("/home/test/.local/share/mcpget/installations");
  });
  it("plans persistent npm installation by default and keeps ephemeral execution explicit", () => {
    const plan = createInstallPlan(candidate());
    expect(plan.requiresExecutionConsent).toBe(true);
    expect(plan.strategy).toBe("managed");
    expect(plan.packageIdentifier).toBe("@example/notion-mcp");
    expect(plan.entry.command).toBe(process.execPath);
    expect(plan.entry.args).toEqual([]);
    const ephemeral = createInstallPlan(
      candidate(),
      undefined,
      undefined,
      true,
    );
    expect(ephemeral.strategy).toBe("ephemeral");
    expect(ephemeral.entry.args?.join(" ")).toContain(
      "@example/notion-mcp@1.2.0",
    );
    expect(ephemeral.entry.args?.some((arg) => arg.includes("&&"))).toBe(false);
  });

  it("installs a scoped npm package in isolation, resolves its executable/version, and reuses it", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcpget-managed-"));
    let installs = 0;
    try {
      const firstRun = async (
        directory: string,
        reference: string,
        timeout: number,
      ) => {
        installs += 1;
        expect(reference).toBe("@example/notion-mcp@1.2.0");
        expect(timeout).toBe(180_000);
        const packageDir = join(
          directory,
          "node_modules",
          "@example",
          "notion-mcp",
        );
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(join(packageDir, "dist"), { recursive: true });
        await writeFile(
          join(packageDir, "package.json"),
          JSON.stringify({
            name: "@example/notion-mcp",
            version: "1.2.0",
            bin: { "notion-mcp": "dist/cli.js" },
          }),
        );
        await writeFile(join(packageDir, "dist", "cli.js"), "process.exit(0)");
        await writeFile(
          join(packageDir, "README.md"),
          "Required API key: THUNDERBIT_API_KEY (format tb_...)\n",
        );
      };
      const first = await installManagedNpm(
        "@example/notion-mcp",
        "1.2.0",
        undefined,
        { installRoot: root, runInstaller: firstRun },
      );
      const second = await installManagedNpm(
        "@example/notion-mcp",
        "1.2.0",
        undefined,
        { installRoot: root, runInstaller: firstRun },
      );
      expect(installs).toBe(1);
      expect(first.directory).toBe(second.directory);
      expect(second.reused).toBe(true);
      expect(second.installedVersion).toBe("1.2.0");
      expect(second.command).toBe(process.execPath);
      expect(second.args[0]).toContain(
        join("node_modules", "@example", "notion-mcp", "dist", "cli.js"),
      );
      expect(second.documentedRequirements).toEqual([
        {
          name: "THUNDERBIT_API_KEY",
          required: true,
          secret: true,
          description: "Required API key: THUNDERBIT_API_KEY (format tb_...)",
          deployment: "local-package",
        },
      ]);
      const metadata = JSON.parse(
        await readFile(
          join(first.directory, "mcpget-installation.json"),
          "utf8",
        ),
      ) as { installedVersion: string };
      expect(metadata.installedVersion).toBe("1.2.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans only the incomplete managed directory after installation failure or timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcpget-managed-failure-"));
    try {
      for (const reason of [
        "Managed npm installation failed with exit code 1.",
        "Managed npm installation timed out.",
      ]) {
        await expect(
          installManagedNpm("@example/broken-mcp", "1.0.0", 5, {
            installRoot: root,
            runInstaller: async (directory) => {
              await import("node:fs/promises").then(({ mkdir, writeFile }) =>
                mkdir(directory, { recursive: true }).then(() =>
                  writeFile(join(directory, "partial.txt"), "partial"),
                ),
              );
              throw new Error(reason);
            },
          }),
        ).rejects.toThrow(reason);
        await expect(
          (await import("node:fs/promises")).readdir(root),
        ).resolves.toEqual([]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes managed package files only after the last client association is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcpget-managed-"));
    const previousDataDir = process.env.MCPGET_DATA_DIR;
    process.env.MCPGET_DATA_DIR = root;
    try {
      const installed = await installManagedNpm(
        "@example/notion-mcp",
        "1.2.0",
        undefined,
        {
          installRoot: join(root, "installations"),
          runInstaller: async (directory) => {
            const packageDir = join(
              directory,
              "node_modules",
              "@example",
              "notion-mcp",
            );
            const { mkdir, writeFile } = await import("node:fs/promises");
            await mkdir(join(packageDir, "dist"), { recursive: true });
            await writeFile(
              join(packageDir, "package.json"),
              JSON.stringify({
                name: "@example/notion-mcp",
                version: "1.2.0",
                bin: "dist/cli.js",
              }),
            );
            await writeFile(join(packageDir, "dist", "cli.js"), "ok");
          },
        },
      );
      const association = {
        serverIdentifier: "io.example/notion",
        serverName: "Notion",
        verificationStatus: "completed",
      };
      await updateManagedMetadata(installed, {
        ...association,
        client: "claude",
        configurationEntry: "notion-claude",
      });
      await updateManagedMetadata(installed, {
        ...association,
        client: "cursor",
        configurationEntry: "notion-cursor",
      });
      expect(
        await releaseManagedAssociation(
          installed.directory,
          association.serverIdentifier,
          "claude",
          "notion-claude",
        ),
      ).toBe(false);
      expect(
        await readFile(
          join(installed.directory, "mcpget-installation.json"),
          "utf8",
        ),
      ).toContain("cursor");
      expect(
        await releaseManagedAssociation(
          installed.directory,
          association.serverIdentifier,
          "cursor",
          "notion-cursor",
        ),
      ).toBe(true);
      await expect(
        readFile(join(installed.directory, "mcpget-installation.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      if (previousDataDir === undefined) delete process.env.MCPGET_DATA_DIR;
      else process.env.MCPGET_DATA_DIR = previousDataDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("plans required secrets without collecting or writing credential values", () => {
    const source = candidate();
    source.operational.configurationInputs = [
      {
        name: "API_TOKEN",
        required: true,
        secret: true,
        deployment: "local-package",
      },
    ];
    const plan = createInstallPlan(source);
    expect(plan.strategy).toBe("managed");
    expect(plan.entry.env).toBeUndefined();
  });

  it("allows OAuth-described requirements without claiming authentication", () => {
    const source = candidate();
    source.operational.configurationInputs = [
      {
        name: "OAUTH_ACCESS_TOKEN",
        required: true,
        secret: true,
        description: "OAuth access token",
        deployment: "local-package",
      },
    ];
    const plan = createInstallPlan(source);
    expect(plan.entry.env).toBeUndefined();
    expect(plan.entry.command).toBe(process.execPath);
  });

  it("requires an explicit choice when both remote and local sources are declared", () => {
    const source = candidate();
    source.operational.deploymentModels.push("Remote endpoint");
    source.operational.remoteEndpoints = ["https://mcp.example.com/mcp"];
    expect(() => createInstallPlan(source)).toThrow(
      /multiple installation sources/i,
    );
    expect(createInstallPlan(source, undefined, "remote").entry.url).toBe(
      "https://mcp.example.com/mcp",
    );
  });

  it("rejects package identifiers that could be interpreted as runtime options", () => {
    const source = candidate();
    source.operational.packages = [
      { registryType: "npm", identifier: "--ignore-scripts=false" },
    ];
    expect(() => createInstallPlan(source)).toThrow(
      /unsupported npm package identifier/i,
    );
  });

  it("disables npm lifecycle scripts by default and uses an explicit separator", () => {
    const [command, args] = npmInvocation(
      "/tmp/managed",
      "@example/notion-mcp@1.2.0",
      false,
    );
    expect(command).toBe(
      process.platform === "win32" ? process.execPath : "npm",
    );
    expect(args).toContain("--ignore-scripts");
    expect(args).toContain("--");
    expect(args.at(-1)).toBe("@example/notion-mcp@1.2.0");
  });

  it("allows lifecycle scripts only through the explicit npm invocation option", () => {
    const [, args] = npmInvocation(
      "/tmp/managed",
      "@example/notion-mcp@1.2.0",
      true,
    );
    expect(args).not.toContain("--ignore-scripts");
    expect(args).toContain("--foreground-scripts");
  });

  it.each(["@scope/package", "@scope/package@1.2.3", "@scope/package@next"])(
    "parses and safely invokes scoped npm reference %s",
    (reference) => {
      const [, args] = npmInvocation("/tmp/managed", reference, false);
      expect(args).toContain("--");
      expect(args.at(-1)).toBe(reference);
      expect(args).toContain("--ignore-scripts");
    },
  );

  it("rejects malformed, empty-version, and option-like npm references", () => {
    for (const reference of [
      "@scope",
      "@/package",
      "@scope/",
      "@scope/package@",
      "--prefix",
      "-evil",
      "package@-option",
      "package@bad tag",
    ]) {
      expect(() => npmInvocation("/tmp/managed", reference, false)).toThrow();
    }
  });

  it("rejects leading-dash and malformed npm identifiers while allowing scoped names and versions", () => {
    expect(() => validateNpmPackageIdentifier("-evil")).toThrow(
      /invalid|option/i,
    );
    expect(() => validateNpmPackageIdentifier(".evil")).toThrow(
      /invalid|option/i,
    );
    expect(() => validateNpmPackageIdentifier("pkg&&evil")).toThrow(
      /invalid|option/i,
    );
    expect(() => validateNpmPackageIdentifier("@scope/pkg")).not.toThrow();
    expect(() => validateNpmPackageIdentifier("simple-package")).not.toThrow();
  });

  it("constructs ephemeral npm plans with lifecycle scripts disabled unless explicitly allowed", () => {
    const source = candidate();
    const disabled = createInstallPlan(
      source,
      undefined,
      undefined,
      true,
      false,
    );
    expect(disabled.entry.args).toContain("--ignore-scripts");
    expect(disabled.entry.args?.at(-1)).toBe("@example/notion-mcp@1.2.0");
    const allowed = createInstallPlan(source, undefined, undefined, true, true);
    expect(allowed.entry.args).not.toContain("--ignore-scripts");
  });

  it("does not silently change lifecycle policy for an existing managed installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcpget-lifecycle-policy-"));
    try {
      const runInstaller = async (directory: string) => {
        const packageDir = join(
          directory,
          "node_modules",
          "@example",
          "safe-mcp",
        );
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(join(packageDir, "dist"), { recursive: true });
        await writeFile(
          join(packageDir, "package.json"),
          JSON.stringify({
            name: "@example/safe-mcp",
            version: "1.0.0",
            bin: { "safe-mcp": "dist/cli.js" },
          }),
        );
        await writeFile(join(packageDir, "dist", "cli.js"), "process.exit(0)");
      };
      await installManagedNpm("@example/safe-mcp", "1.0.0", undefined, {
        installRoot: root,
        allowLifecycleScripts: false,
        runInstaller,
      });
      await expect(
        installManagedNpm("@example/safe-mcp", "1.0.0", undefined, {
          installRoot: root,
          allowLifecycleScripts: true,
          runInstaller,
        }),
      ).rejects.toThrow(/lifecycle scripts.*disabled|Remove and reinstall/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves unrelated settings and makes repeat installs idempotent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcpget-test-"));
    const path = join(dir, "mcp.json");
    try {
      const original =
        '{"otherSetting":true,"mcpServers":{"existing":{"url":"https://example.test/mcp"}}}\n';
      await import("node:fs/promises").then(({ writeFile }) =>
        writeFile(path, original),
      );
      const adapter = new JsonClientAdapter("cursor", "Cursor", path);
      const entry = {
        name: "notion-tools",
        command: "node",
        args: ["server.js"],
      };
      await adapter.add(entry);
      await adapter.add({ ...entry });
      const config = JSON.parse(await readFile(path, "utf8")) as {
        otherSetting: boolean;
        mcpServers: Record<string, { type?: string }>;
      };
      expect(config.otherSetting).toBe(true);
      expect(config.mcpServers.existing).toBeDefined();
      expect(config.mcpServers[entry.name]?.type).toBe("stdio");
      await expect(readFile(`${path}.mcpget.bak`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(Object.keys(config.mcpServers)).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses malformed existing JSON without overwriting it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcpget-test-"));
    const path = join(dir, "mcp.json");
    try {
      await import("node:fs/promises").then(({ writeFile }) =>
        writeFile(path, "not json"),
      );
      const adapter = new JsonClientAdapter("claude", "Claude", path);
      await expect(
        adapter.add({ name: "test", command: "node" }),
      ).rejects.toThrow(/not valid JSON/i);
      expect(await readFile(path, "utf8")).toBe("not json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("manages Codex TOML directly and preserves the existing remote entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcpget-codex-"));
    const path = join(dir, "config.toml");
    const original =
      "model = 'kept'\n[mcp_servers.existing]\nurl = 'https://example.test/mcp'\n";
    try {
      await writeFile(path, original);
      let cliCalls = 0;
      const adapter = new CodexAdapter(path, async () => {
        cliCalls += 1;
        throw new Error(
          "Codex CLI must not be invoked for configuration management.",
        );
      });
      await adapter.add({
        name: "new-server",
        url: "https://mcp.example.test",
      });
      expect(cliCalls).toBe(0);
      await expect(readFile(`${path}.mcpget.bak`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await adapter.read())["new-server"]).toBeDefined();
      expect((await adapter.read()).existing).toEqual({
        name: "existing",
        url: "https://example.test/mcp",
        transport: "streamable_http",
      });
      expect(await adapter.remove("new-server")).toBe(true);
      await expect(readFile(`${path}.mcpget.bak`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(cliCalls).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
