import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../../src/installers/codex-adapter.js";

const mocks = vi.hoisted(() => ({
  findManagedNpm: vi.fn(),
  installManagedNpm: vi.fn(),
  managedInstallPath: vi.fn(),
  releaseManagedAssociation: vi.fn(),
  updateManagedMetadata: vi.fn(),
  verifyStdioMcp: vi.fn(),
  verifyHttpMcp: vi.fn(),
  journalBegin: vi.fn(),
  journalAdvance: vi.fn(),
  journalComplete: vi.fn(),
  readlineAnswers: [] as string[],
  readlineQuestions: [] as string[],
  records: [] as unknown[],
}));

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    once: vi.fn(),
    removeListener: vi.fn(),
    question: async (prompt: string) => {
      mocks.readlineQuestions.push(prompt);
      return mocks.readlineAnswers.shift() ?? "y";
    },
    close: vi.fn(),
  }),
}));

vi.mock("../../src/installers/managed-npm.js", () => ({
  findManagedNpm: mocks.findManagedNpm,
  installManagedNpm: mocks.installManagedNpm,
  managedInstallPath: mocks.managedInstallPath,
  releaseManagedAssociation: mocks.releaseManagedAssociation,
  updateManagedMetadata: mocks.updateManagedMetadata,
}));

vi.mock("../../src/installers/state-store.js", () => ({
  InstallationStateStore: class {
    async all(): Promise<unknown[]> {
      return mocks.records;
    }
    async get(): Promise<undefined> {
      return undefined;
    }
    async put(record: unknown): Promise<void> {
      mocks.records.push(record);
    }
  },
}));

vi.mock("../../src/installers/operation-journal.js", () => ({
  OperationJournal: class {
    async list(): Promise<unknown[]> {
      return [];
    }
    async listBackupResolutions(): Promise<unknown[]> {
      return [];
    }
    async beginBackupResolution(
      resolution: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      return {
        schemaVersion: 1,
        id: "22222222-2222-4222-8222-222222222222",
        kind: "configuration_backup_resolution",
        action: "archive_orphaned_backup",
        status: "started",
        ...resolution,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    async finishBackupResolution(): Promise<void> {}
    async begin(): Promise<{ id: string }> {
      await mocks.journalBegin();
      return { id: "11111111-1111-4111-8111-111111111111" };
    }
    async advance(): Promise<void> {
      await mocks.journalAdvance();
    }
    async complete(): Promise<void> {
      await mocks.journalComplete();
    }
  },
}));

vi.mock("../../src/verification/mcp-connection.js", () => ({
  verifyStdioMcp: mocks.verifyStdioMcp,
  verifyHttpMcp: mocks.verifyHttpMcp,
}));

import { registerInstallCommand } from "../../src/cli/commands/install.js";

describe("Codex installation without the Codex CLI", () => {
  const previousEnvironment = {
    path: process.env.PATH,
    pathext: process.env.PATHEXT,
    codexHome: process.env.CODEX_HOME,
  };
  const stdinDescriptor = Object.getOwnPropertyDescriptor(
    process.stdin,
    "isTTY",
  );
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(
    process.stdout,
    "isTTY",
  );

  afterEach(() => {
    if (previousEnvironment.path === undefined) delete process.env.PATH;
    else process.env.PATH = previousEnvironment.path;
    if (previousEnvironment.pathext === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = previousEnvironment.pathext;
    if (previousEnvironment.codexHome === undefined)
      delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousEnvironment.codexHome;
    if (stdinDescriptor)
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    if (stdoutDescriptor)
      Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    process.exitCode = 0;
    mocks.records.length = 0;
    mocks.readlineAnswers.length = 0;
    mocks.readlineQuestions.length = 0;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("installs, writes, and independently verifies Codex TOML while no CLI is on PATH", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-codex-install-"),
    );
    const emptyPath = path.join(directory, "empty-path");
    const codexHome = path.join(directory, ".codex");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const wasStdinPaused = process.stdin.isPaused();
    try {
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(emptyPath, { recursive: true }),
      );
      process.env.PATH = emptyPath;
      process.env.PATHEXT = "";
      process.env.CODEX_HOME = codexHome;
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        path.join(codexHome, "config.toml"),
        '[mcp_servers.existing]\ncommand = "node"\nargs = ["existing.js"]\n',
      );
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: true,
      });

      mocks.findManagedNpm.mockResolvedValue(undefined);
      mocks.managedInstallPath.mockReturnValue(
        path.join(directory, "installation"),
      );
      mocks.installManagedNpm.mockResolvedValue({
        directory: path.join(directory, "installation"),
        packageIdentifier: "@example/server",
        installedVersion: "1.0.0",
        command: process.execPath,
        args: [path.join(directory, "server.js")],
        reused: false,
        documentedRequirements: [],
      });
      mocks.verifyStdioMcp.mockResolvedValue({
        status: "connection_verified",
        detail: "MCP initialize succeeded.",
        startupVerified: true,
        protocolVersion: "2025-03-26",
      });

      const program = new Command();
      registerInstallCommand(program);
      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "npm:@example/server",
        "codex",
      ]);

      expect(errors).not.toHaveBeenCalled();
      expect(process.exitCode ?? 0).toBe(0);
      expect(output.mock.calls.flat().join("\n")).toContain(
        "[COMPLETED] configured",
      );
      expect(output.mock.calls.flat().join("\n")).toContain(
        "[COMPLETED] connection_verified",
      );
      expect(output.mock.calls.flat().join("\n")).toContain(
        "AUTHENTICATION NOT VERIFIED",
      );
      expect(mocks.records.length).toBeGreaterThan(1);
      const savedConfig = await readFile(
        path.join(codexHome, "config.toml"),
        "utf8",
      );
      expect(savedConfig).toContain("[mcp_servers.existing]");
      expect(savedConfig).toContain("[mcp_servers.");
    } finally {
      if (stdinDescriptor)
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      if (stdoutDescriptor)
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      if (wasStdinPaused) process.stdin.pause();
      else process.stdin.resume();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recognizes an exact existing registration before package installation or journaling", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-codex-existing-duplicate-"),
    );
    const codexHome = path.join(directory, ".codex");
    const configPath = path.join(codexHome, "config.toml");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        configPath,
        [
          "[mcp_servers.example-server]",
          `command = ${JSON.stringify(process.execPath)}`,
          "args = []",
          "",
        ].join("\n"),
      );
      process.env.CODEX_HOME = codexHome;
      const program = new Command();
      registerInstallCommand(program);

      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "npm:@example/server",
        "codex",
        "--json",
      ]);

      const response = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        ok: boolean;
        data: { alreadyConfigured: boolean; existingRegistrations: unknown[] };
      };
      expect(response).toMatchObject({
        ok: true,
        data: {
          alreadyConfigured: true,
          existingRegistrations: [
            { classification: "confirmed_duplicate", name: "example-server" },
          ],
        },
      });
      expect(mocks.installManagedNpm).not.toHaveBeenCalled();
      expect(mocks.journalBegin).not.toHaveBeenCalled();
      expect(await readFile(configPath, "utf8")).toContain(
        "[mcp_servers.example-server]",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("detects a trusted project registration without installing into another scope", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-codex-project-duplicate-"),
    );
    const codexHome = path.join(directory, "codex-home");
    const projectRoot = path.join(directory, "repo");
    const projectConfigPath = path.join(projectRoot, ".codex", "config.toml");
    const previousCwd = process.cwd();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await mkdir(path.join(projectRoot, ".git"), { recursive: true });
      await mkdir(path.dirname(projectConfigPath), { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        path.join(codexHome, "config.toml"),
        `[projects.${JSON.stringify(projectRoot)}]\ntrust_level = "trusted"\n`,
      );
      await writeFile(
        projectConfigPath,
        [
          "[mcp_servers.example-server]",
          `command = ${JSON.stringify(process.execPath)}`,
          "args = []",
          "",
        ].join("\n"),
      );
      process.env.CODEX_HOME = codexHome;
      process.chdir(projectRoot);
      const program = new Command();
      registerInstallCommand(program);

      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "npm:@example/server",
        "codex",
        "--scope",
        "project",
        "--config",
        projectConfigPath,
        "--json",
      ]);

      const response = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        ok: boolean;
        data: {
          alreadyConfigured: boolean;
          existingRegistrations: Array<{ scope: string; configPath: string }>;
        };
      };
      expect(response).toMatchObject({
        ok: true,
        data: {
          alreadyConfigured: true,
          existingRegistrations: [
            { scope: "project", configPath: projectConfigPath },
          ],
        },
      });
      expect(mocks.installManagedNpm).not.toHaveBeenCalled();
      expect(mocks.journalBegin).not.toHaveBeenCalled();
      expect(await readFile(projectConfigPath, "utf8")).toContain(
        "[mcp_servers.example-server]",
      );
      expect(
        await readFile(path.join(codexHome, "config.toml"), "utf8"),
      ).toContain('trust_level = "trusted"');
    } finally {
      process.chdir(previousCwd);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires explicit approval for a different-name package match before any installation work", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-codex-possible-duplicate-"),
    );
    const codexHome = path.join(directory, "codex-home");
    const configPath = path.join(codexHome, "config.toml");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        configPath,
        [
          "[mcp_servers.existing-alias]",
          'command = "npx"',
          'args = ["--yes", "--", "@example/server"]',
          "",
        ].join("\n"),
      );
      process.env.CODEX_HOME = codexHome;
      mocks.readlineAnswers.push("n");
      const program = new Command();
      registerInstallCommand(program);

      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "npm:@example/server",
        "codex",
        "--json",
      ]);

      const response = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        ok: boolean;
        data?: Record<string, unknown>;
        error?: Record<string, unknown>;
      };
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: "CANCELLED",
          message: expect.stringContaining("possible"),
        },
      });
      expect(mocks.readlineQuestions.join("\n")).toContain(
        "Proceed with another registration?",
      );
      expect(mocks.installManagedNpm).not.toHaveBeenCalled();
      expect(mocks.journalBegin).not.toHaveBeenCalled();
      expect(await readFile(configPath, "utf8")).toContain(
        "[mcp_servers.existing-alias]",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a registration-name conflict without replacing the existing entry", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-codex-name-conflict-"),
    );
    const codexHome = path.join(directory, "codex-home");
    const configPath = path.join(codexHome, "config.toml");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        configPath,
        [
          "[mcp_servers.example-server]",
          'command = "node"',
          'args = ["different-server.js"]',
          "",
        ].join("\n"),
      );
      process.env.CODEX_HOME = codexHome;
      const program = new Command();
      registerInstallCommand(program);

      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "npm:@example/server",
        "codex",
        "--json",
      ]);

      expect(JSON.parse(output.mock.calls[0]?.[0] as string)).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: expect.stringContaining("registration name"),
        },
      });
      expect(mocks.installManagedNpm).not.toHaveBeenCalled();
      expect(mocks.journalBegin).not.toHaveBeenCalled();
      expect(await readFile(configPath, "utf8")).toContain(
        'args = ["different-server.js"]',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { client: "claude", displayName: "Claude Desktop" },
    { client: "cursor", displayName: "Cursor" },
    { client: "codex", displayName: "OpenAI Codex" },
  ])(
    "uses one confirmation with scripts disabled by default for $client",
    async ({ client, displayName }) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "mcpget-install-script-prompt-"),
      );
      const stdinDescriptor = Object.getOwnPropertyDescriptor(
        process.stdin,
        "isTTY",
      );
      const stdoutDescriptor = Object.getOwnPropertyDescriptor(
        process.stdout,
        "isTTY",
      );
      const previousEnvironment = {
        codexHome: process.env.CODEX_HOME,
        claudeConfigPath: process.env.MCPGET_CLAUDE_CONFIG_PATH,
        userProfile: process.env.USERPROFILE,
        home: process.env.HOME,
      };
      const output = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      try {
        if (client === "claude")
          process.env.MCPGET_CLAUDE_CONFIG_PATH = path.join(
            directory,
            "claude.json",
          );
        else if (client === "cursor") {
          process.env.USERPROFILE = directory;
          process.env.HOME = directory;
        } else process.env.CODEX_HOME = path.join(directory, ".codex");
        Object.defineProperty(process.stdin, "isTTY", {
          configurable: true,
          value: true,
        });

        Object.defineProperty(process.stdout, "isTTY", {
          configurable: true,
          value: true,
        });
        mocks.readlineAnswers.push("y");
        mocks.findManagedNpm.mockResolvedValue(undefined);
        mocks.managedInstallPath.mockReturnValue(
          path.join(directory, "installation"),
        );
        mocks.installManagedNpm.mockResolvedValue({
          directory: path.join(directory, "installation"),
          packageIdentifier: "@example/server",
          installedVersion: "1.0.0",
          command: process.execPath,
          args: ["server.js"],
          reused: false,
          lifecycleScriptsEnabled: false,
        });
        mocks.verifyStdioMcp.mockResolvedValue({
          status: "connection_verified",
          detail: "MCP initialize succeeded.",
          startupVerified: true,
        });

        const program = new Command();
        registerInstallCommand(program);
        await program.parseAsync([
          "node",
          "mcpget",
          "install",
          "npm:@example/server",
          client,
        ]);

        expect(mocks.readlineQuestions).toHaveLength(1);
        expect(mocks.readlineQuestions[0]).toBe("Continue? [y/N] ");
        expect(mocks.installManagedNpm).toHaveBeenCalledWith(
          "@example/server",
          undefined,
          180_000,
          { allowLifecycleScripts: false },
        );
        const rendered = output.mock.calls.flat().join("\n");
        expect(rendered).toContain(`Target: ${displayName}`);
        expect(rendered).toContain("Package: @example/server");
        expect(rendered).toContain(
          "Version: latest; resolved version will be recorded",
        );
        expect(rendered).toContain("Installation location:");
        expect(rendered).toContain(
          "Package installation scripts: disabled by default.",
        );
        expect(rendered).not.toContain("separately approved");
        expect(rendered.toLowerCase()).not.toContain("npm lifecycle scripts");
      } finally {
        if (previousEnvironment.codexHome === undefined)
          delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousEnvironment.codexHome;
        if (previousEnvironment.claudeConfigPath === undefined)
          delete process.env.MCPGET_CLAUDE_CONFIG_PATH;
        else
          process.env.MCPGET_CLAUDE_CONFIG_PATH =
            previousEnvironment.claudeConfigPath;
        if (previousEnvironment.userProfile === undefined)
          delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousEnvironment.userProfile;
        if (previousEnvironment.home === undefined) delete process.env.HOME;
        else process.env.HOME = previousEnvironment.home;
        if (stdinDescriptor)
          Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
        if (stdoutDescriptor)
          Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
        process.exitCode = 0;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("still requests documented required credentials after installation approval", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-install-credential-prompt-"),
    );
    const stdinDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      process.env.CODEX_HOME = path.join(directory, ".codex");
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: true,
      });
      mocks.readlineAnswers.push("y", "west");
      mocks.findManagedNpm.mockResolvedValue(undefined);
      mocks.managedInstallPath.mockReturnValue(
        path.join(directory, "installation"),
      );
      mocks.installManagedNpm.mockResolvedValue({
        directory: path.join(directory, "installation"),
        packageIdentifier: "@example/server",
        installedVersion: "1.0.0",
        command: process.execPath,
        args: ["server.js"],
        reused: false,
        documentedRequirements: [
          {
            name: "SERVICE_REGION",
            required: true,
            secret: false,
            description: "Service region",
            deployment: "local-package",
          },
        ],
      });
      mocks.verifyStdioMcp.mockResolvedValue({
        status: "connection_verified",
        detail: "MCP initialize succeeded.",
        startupVerified: true,
      });

      const program = new Command();
      registerInstallCommand(program);
      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "npm:@example/server",
        "codex",
      ]);

      expect(mocks.readlineQuestions).toHaveLength(2);
      expect(mocks.readlineQuestions[0]).toBe("Continue? [y/N] ");
      expect(mocks.readlineQuestions[1]).toContain("SERVICE_REGION");
      expect(output.mock.calls.flat().join("\n")).toContain(
        "[COMPLETED] configured",
      );
      expect(
        await readFile(path.join(directory, ".codex", "config.toml"), "utf8"),
      ).toContain("SERVICE_REGION");
    } finally {
      if (stdinDescriptor)
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      if (stdoutDescriptor)
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      process.exitCode = 0;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels cleanly when the user declines installation", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-install-declined-"),
    );
    const stdinDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      process.env.CODEX_HOME = path.join(directory, ".codex");
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: true,
      });
      mocks.readlineAnswers.push("n");

      const program = new Command();
      registerInstallCommand(program);
      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "npm:@example/server",
        "codex",
        "--json",
      ]);

      expect(mocks.readlineQuestions).toEqual(["Continue? [y/N] "]);
      expect(mocks.installManagedNpm).not.toHaveBeenCalled();
      expect(mocks.journalBegin).not.toHaveBeenCalled();
      expect(JSON.parse(output.mock.calls[0]?.[0] as string)).toMatchObject({
        ok: false,
        error: { code: "CANCELLED" },
      });
      expect(process.exitCode).toBe(130);
    } finally {
      if (stdinDescriptor)
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      if (stdoutDescriptor)
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      process.exitCode = 0;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("automatically archives a validated stale backup during install preflight", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-codex-auto-backup-"),
    );
    const codexHome = path.join(directory, ".codex");
    const configPath = path.join(codexHome, "config.toml");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        configPath,
        [
          'model = "active"',
          "",
          "[mcp_servers.existing]",
          'command = "node"',
          'args = ["existing.js"]',
          "",
        ].join("\n"),
      );
      await writeFile(
        `${configPath}.mcpget.bak`,
        [
          'model = "old"',
          "",
          "[mcp_servers.existing]",
          'command = "node"',
          'args = ["old.js"]',
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      process.env.CODEX_HOME = codexHome;
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: false,
      });
      mocks.findManagedNpm.mockResolvedValue(undefined);
      mocks.managedInstallPath.mockReturnValue(
        path.join(directory, "installation"),
      );
      mocks.installManagedNpm.mockResolvedValue({
        directory: path.join(directory, "installation"),
        packageIdentifier: "@example/server",
        installedVersion: "1.0.0",
        command: process.execPath,
        args: ["server.js"],
        reused: false,
      });
      mocks.verifyStdioMcp.mockResolvedValue({
        status: "connection_verified",
        detail: "MCP initialize succeeded.",
        startupVerified: true,
      });

      const program = new Command();
      registerInstallCommand(program);
      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "npm:@example/server",
        "codex",
        "--json",
        "--yes",
      ]);

      expect(mocks.findManagedNpm).toHaveBeenCalled();
      expect(mocks.installManagedNpm).toHaveBeenCalled();
      expect(output.mock.calls.flat().join("\n")).toContain('"ok": true');
      const files = await readdir(codexHome);
      expect(files.some((file) => file.endsWith(".mcpget.bak"))).toBe(false);
      const archive = files.find((file) =>
        file.includes(".mcpget.bak.archive."),
      );
      expect(archive).toBeDefined();
      expect(await readFile(path.join(codexHome, archive!), "utf8")).toContain(
        'model = "old"',
      );
      expect(await readFile(configPath, "utf8")).toContain(
        "[mcp_servers.existing]",
      );
    } finally {
      process.exitCode = 0;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("blocks package work and credential prompts when configuration preflight finds a backup", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-install-preflight-backup-"),
    );
    const codexHome = path.join(directory, ".codex");
    const configPath = path.join(codexHome, "config.toml");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(configPath, "");
      await writeFile(`${configPath}.mcpget.bak`, "retained backup");
      process.env.CODEX_HOME = codexHome;
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: false,
      });

      const program = new Command();
      registerInstallCommand(program);
      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "npm:@example/server",
        "codex",
        "--json",
        "--yes",
      ]);

      const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        ok: boolean;
        error: { code: string; message: string };
        partial?: {
          record?: {
            installation?: Record<string, unknown>;
            states?: { installed?: { status: string } };
          };
        };
      };
      expect(payload).toMatchObject({
        ok: false,
        error: { code: "OPERATIONAL_FAILURE" },
      });
      expect(payload.error.message).toContain(
        "cannot yet register this MCP server",
      );
      expect(payload.error.message).toContain("mcpget doctor codex");
      expect(payload.partial?.record?.installation).not.toHaveProperty(
        "installedVersion",
      );
      expect(payload.partial?.record?.states?.installed?.status).not.toBe(
        "completed",
      );
      expect(mocks.findManagedNpm).not.toHaveBeenCalled();
      expect(mocks.installManagedNpm).not.toHaveBeenCalled();
      expect(mocks.readlineQuestions).toHaveLength(0);
      expect(mocks.journalBegin).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = 0;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preflights the selected Cursor profile before package work", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-cursor-preflight-backup-"),
    );
    const previousUserProfile = process.env.USERPROFILE;
    const previousHome = process.env.HOME;
    const cursorHome = path.join(directory, "profile");
    const cursorDirectory = path.join(cursorHome, ".cursor");
    const configPath = path.join(cursorDirectory, "mcp.json");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await mkdir(cursorDirectory, { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({ mcpServers: { existing: { command: "node" } } }),
      );
      await writeFile(`${configPath}.mcpget.bak`, "retained backup");
      process.env.USERPROFILE = cursorHome;
      process.env.HOME = cursorHome;
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: false,
      });

      const program = new Command();
      registerInstallCommand(program);
      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "npm:@example/server",
        "cursor",
        "--json",
        "--yes",
      ]);

      const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(payload.error.message).toContain("mcpget doctor cursor");
      expect(mocks.findManagedNpm).not.toHaveBeenCalled();
      expect(mocks.installManagedNpm).not.toHaveBeenCalled();
      expect(mocks.readlineQuestions).toHaveLength(0);
      expect(mocks.journalBegin).not.toHaveBeenCalled();
    } finally {
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      process.exitCode = 0;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("blocks package work when the existing client configuration is invalid", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-install-preflight-invalid-config-"),
    );
    const codexHome = path.join(directory, ".codex");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(path.join(codexHome, "config.toml"), "not valid = [");
      process.env.CODEX_HOME = codexHome;
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: false,
      });

      const program = new Command();
      registerInstallCommand(program);
      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "npm:@example/server",
        "codex",
        "--json",
        "--yes",
      ]);

      const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(payload.error.message).toContain(
        "existing configuration or its file permissions",
      );
      expect(payload.error.message).toContain("malformed TOML");
      expect(mocks.findManagedNpm).not.toHaveBeenCalled();
      expect(mocks.installManagedNpm).not.toHaveBeenCalled();
      expect(mocks.journalBegin).not.toHaveBeenCalled();
    } finally {
      process.exitCode = 0;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "persistent",
      flags: [] as string[],
      json: false,
      installationStatus: "INSTALLATION COMPLETED",
    },
    {
      name: "ephemeral",
      flags: ["--ephemeral"],
      json: false,
      installationStatus: "INSTALLATION NOT_APPLICABLE",
    },
    {
      name: "JSON",
      flags: ["--json"],
      json: true,
      installationStatus: "",
    },
  ])(
    "reports configuration failure for $name installation",
    async ({ flags, json, installationStatus }) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "mcpget-codex-config-failure-"),
      );
      const emptyPath = path.join(directory, "empty-path");
      const output = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      const errors = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const wasStdinPaused = process.stdin.isPaused();
      const failureMessage =
        `Synthetic configuration write failure. ${"diagnostic ".repeat(20)}`.trimEnd();
      const addSpy = vi
        .spyOn(CodexAdapter.prototype, "add")
        .mockRejectedValue(new Error(failureMessage));
      try {
        await import("node:fs/promises").then(({ mkdir }) =>
          mkdir(emptyPath, { recursive: true }),
        );
        process.env.PATH = emptyPath;
        process.env.PATHEXT = "";
        process.env.CODEX_HOME = path.join(directory, ".codex");
        Object.defineProperty(process.stdin, "isTTY", {
          configurable: true,
          value: true,
        });
        Object.defineProperty(process.stdout, "isTTY", {
          configurable: true,
          value: true,
        });

        mocks.findManagedNpm.mockResolvedValue(undefined);
        mocks.managedInstallPath.mockReturnValue(
          path.join(directory, "installation"),
        );
        mocks.installManagedNpm.mockResolvedValue({
          directory: path.join(directory, "installation"),
          packageIdentifier: "@example/server",
          installedVersion: "1.0.0",
          command: process.execPath,
          args: [path.join(directory, "server.js")],
          reused: false,
          documentedRequirements: [],
        });
        mocks.verifyStdioMcp.mockResolvedValue({
          status: "connection_verified",
          detail: "MCP initialize succeeded.",
          startupVerified: true,
          protocolVersion: "2025-03-26",
        });

        const program = new Command();
        registerInstallCommand(program);
        await program.parseAsync([
          "node",
          "mcpget",
          "install",
          "npm:@example/server",
          "codex",
          ...flags,
        ]);

        if (json) {
          const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
            ok: boolean;
            command: string;
            error: { code: string; message: string };
            partial: {
              record: {
                configuration: { status: string };
                states: {
                  configured: { status: string };
                  connection_verified: { status: string };
                  authenticated: { status: string };
                };
                partial: { lastError: string };
              };
            };
          };
          expect(payload).toMatchObject({
            ok: false,
            command: "install",
            error: {
              code: "OPERATIONAL_FAILURE",
              message: failureMessage,
            },
            partial: {
              record: {
                configuration: { status: "failed" },
                states: {
                  configured: { status: "failed", detail: failureMessage },
                  connection_verified: { status: "completed" },
                  authenticated: { status: "not_verified" },
                },
                partial: {
                  lastError: expect.stringContaining(
                    "Synthetic configuration write failure.",
                  ),
                },
              },
            },
          });
          expect(errors).not.toHaveBeenCalled();
          expect(process.exitCode).toBe(1);
        } else {
          const summary = errors.mock.calls.flat().join("\n");
          const rendered = [...output.mock.calls, ...errors.mock.calls]
            .flat()
            .join("\n");
          expect(summary).toContain(
            `${installationStatus}; CLIENT CONFIGURATION FAILED; MCP PROTOCOL VERIFICATION COMPLETED; AUTHENTICATION NOT VERIFIED`,
          );
          expect(summary).toContain(`[FAILED] configured: ${failureMessage}`);
          expect(
            rendered.match(/Synthetic configuration write failure\./g),
          ).toHaveLength(1);
          expect(rendered).not.toContain("Configuration failed:");
          expect(rendered).not.toContain("Install failed:");
          expect(process.exitCode).toBe(1);
        }
        expect(mocks.records.length).toBeGreaterThan(1);
        expect(addSpy).toHaveBeenCalledOnce();
      } finally {
        if (stdinDescriptor)
          Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
        if (stdoutDescriptor)
          Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
        if (wasStdinPaused) process.stdin.pause();
        else process.stdin.resume();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("requires --yes for non-interactive JSON installation", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-install-json-no-yes-"),
    );
    const stdinDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      process.env.CODEX_HOME = path.join(directory, ".codex");
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: false,
      });
      const program = new Command();
      registerInstallCommand(program);
      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "npm:@example/server",
        "codex",
        "--json",
      ]);
      const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        ok: boolean;
        command: string;
        error: { code: string };
      };
      expect(payload).toMatchObject({
        ok: false,
        command: "install",
        error: { code: "MISSING_REQUIRED_INPUT" },
      });
      expect(errors).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(4);
      expect(mocks.installManagedNpm).not.toHaveBeenCalled();
    } finally {
      if (stdinDescriptor)
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      if (stdoutDescriptor)
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      process.exitCode = 0;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("passes separate lifecycle-script approval to managed npm installs", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-install-lifecycle-enabled-"),
    );
    const stdinDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      process.env.CODEX_HOME = path.join(directory, ".codex");
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: false,
      });
      mocks.findManagedNpm.mockResolvedValue(undefined);
      mocks.managedInstallPath.mockReturnValue(
        path.join(directory, "installation"),
      );
      mocks.installManagedNpm.mockResolvedValue({
        directory: path.join(directory, "installation"),
        packageIdentifier: "@example/server",
        installedVersion: "1.0.0",
        command: process.execPath,
        args: ["server.js"],
        reused: false,
        lifecycleScriptsEnabled: true,
      });
      mocks.verifyStdioMcp.mockResolvedValue({
        status: "connection_verified",
        detail: "MCP initialize succeeded.",
        startupVerified: true,
      });
      const program = new Command();
      registerInstallCommand(program);
      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "npm:@example/server",
        "codex",
        "--json",
        "--yes",
        "--allow-lifecycle-scripts",
      ]);
      expect(mocks.installManagedNpm).toHaveBeenCalledWith(
        "@example/server",
        undefined,
        180_000,
        { allowLifecycleScripts: true },
      );
      const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        data: { installation: { lifecycleScriptsEnabled: boolean } };
      };
      expect(payload.data.installation.lifecycleScriptsEnabled).toBe(true);
    } finally {
      if (stdinDescriptor)
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      if (stdoutDescriptor)
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      process.exitCode = 0;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not let general --yes authorize lifecycle scripts", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-install-yes-lifecycle-"),
    );
    const stdinDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      process.env.CODEX_HOME = path.join(directory, ".codex");
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: false,
      });
      mocks.findManagedNpm.mockResolvedValue(undefined);
      mocks.managedInstallPath.mockReturnValue(
        path.join(directory, "installation"),
      );
      mocks.installManagedNpm.mockResolvedValue({
        directory: path.join(directory, "installation"),
        packageIdentifier: "@example/server",
        installedVersion: "1.0.0",
        command: process.execPath,
        args: ["server.js"],
        reused: false,
        lifecycleScriptsEnabled: false,
      });
      mocks.verifyStdioMcp.mockResolvedValue({
        status: "connection_verified",
        detail: "MCP initialize succeeded.",
        startupVerified: true,
      });
      const program = new Command();
      registerInstallCommand(program);
      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "npm:@example/server",
        "codex",
        "--json",
        "--yes",
      ]);
      expect(mocks.installManagedNpm).toHaveBeenCalledWith(
        "@example/server",
        undefined,
        180_000,
        { allowLifecycleScripts: false },
      );
      const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        data: { installation: { lifecycleScriptsEnabled: boolean } };
      };
      expect(payload.data.installation.lifecycleScriptsEnabled).toBe(false);
    } finally {
      if (stdinDescriptor)
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      if (stdoutDescriptor)
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      process.exitCode = 0;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsupported --source values in JSON mode", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-install-json-source-"),
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      process.env.CODEX_HOME = path.join(directory, ".codex");
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: false,
      });
      const program = new Command();
      registerInstallCommand(program);
      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "npm:@example/server",
        "codex",
        "--json",
        "--yes",
        "--source",
        "remote",
      ]);
      const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        ok: boolean;
        command: string;
        error: { code: string };
      };
      expect(payload).toMatchObject({
        ok: false,
        command: "install",
        error: { code: "UNSUPPORTED_OPERATION" },
      });
      expect(process.exitCode).toBe(3);
    } finally {
      if (stdoutDescriptor)
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      process.exitCode = 0;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports missing persistent package credentials as a partial JSON failure", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-install-persistent-missing-"),
    );
    const stdinDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      process.env.CODEX_HOME = path.join(directory, ".codex");
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: false,
      });
      mocks.findManagedNpm.mockResolvedValue(undefined);
      mocks.managedInstallPath.mockReturnValue(
        path.join(directory, "installation"),
      );
      mocks.installManagedNpm.mockResolvedValue({
        directory: path.join(directory, "installation"),
        packageIdentifier: "@example/server",
        installedVersion: "1.0.0",
        command: process.execPath,
        args: ["server.js"],
        reused: false,
        documentedRequirements: [
          {
            name: "ACCEPTANCE_TOKEN",
            required: true,
            secret: true,
            description: "Acceptance token",
            deployment: "local-package",
          },
        ],
      });
      const program = new Command();
      registerInstallCommand(program);
      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "npm:@example/server",
        "codex",
        "--json",
        "--yes",
      ]);
      const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        ok: boolean;
        command: string;
        error: { code: string; message: string };
        partial?: {
          record?: {
            states?: { setup_required?: { status: string } };
          };
        };
      };
      expect(payload).toMatchObject({
        ok: false,
        command: "install",
        error: { code: "MISSING_REQUIRED_INPUT" },
      });
      expect(payload.error.message).toContain("ACCEPTANCE_TOKEN");
      expect(JSON.stringify(payload)).not.toContain("secret-token");
      expect(payload.partial?.record?.states?.setup_required?.status).toBe(
        "setup_required",
      );
      expect(mocks.installManagedNpm).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(4);
    } finally {
      if (stdinDescriptor)
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      if (stdoutDescriptor)
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      process.exitCode = 0;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the adapter backup guard effective if a blocker appears after preflight", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-install-preflight-race-"),
    );
    const codexHome = path.join(directory, ".codex");
    const configPath = path.join(codexHome, "config.toml");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      process.env.CODEX_HOME = codexHome;
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: false,
      });
      mocks.managedInstallPath.mockReturnValue(
        path.join(directory, "installation"),
      );
      mocks.installManagedNpm.mockResolvedValue({
        directory: path.join(directory, "installation"),
        packageIdentifier: "@example/server",
        installedVersion: "1.0.0",
        command: process.execPath,
        args: ["server.js"],
        reused: false,
        documentedRequirements: [],
      });
      mocks.verifyStdioMcp.mockImplementation(async () => {
        await mkdir(codexHome, { recursive: true });
        await writeFile(`${configPath}.mcpget.bak`, "retained backup");
        return {
          status: "connection_verified",
          detail: "MCP initialize succeeded.",
          startupVerified: true,
        };
      });

      const program = new Command();
      registerInstallCommand(program);
      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "npm:@example/server",
        "codex",
        "--json",
        "--yes",
      ]);

      const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(payload).toMatchObject({
        ok: false,
        error: { code: "OPERATIONAL_FAILURE" },
      });
      expect(payload.error.message).toContain("mcpget doctor codex");
      expect(mocks.installManagedNpm).toHaveBeenCalledOnce();
      await expect(readFile(`${configPath}.mcpget.bak`, "utf8")).resolves.toBe(
        "retained backup",
      );
      await expect(readFile(configPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      process.exitCode = 0;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["endpoint_unreachable", "The endpoint is unreachable.", false],
    [
      "startup_failed",
      "The configured executable could not be started.",
      false,
    ],
    ["timeout", "MCP connection verification timed out.", false],
    ["initialization_failed", "MCP protocol initialization failed.", true],
  ] as const)(
    "returns operational failure for verification status %s",
    async (status, detail, startupVerified) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "mcpget-install-verification-failure-"),
      );
      const stdinDescriptor = Object.getOwnPropertyDescriptor(
        process.stdin,
        "isTTY",
      );
      const stdoutDescriptor = Object.getOwnPropertyDescriptor(
        process.stdout,
        "isTTY",
      );
      const output = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      try {
        process.env.CODEX_HOME = path.join(directory, ".codex");
        Object.defineProperty(process.stdin, "isTTY", {
          configurable: true,
          value: false,
        });
        Object.defineProperty(process.stdout, "isTTY", {
          configurable: true,
          value: false,
        });
        mocks.verifyHttpMcp.mockResolvedValue({
          status,
          detail,
          startupVerified,
        });
        const program = new Command();
        registerInstallCommand(program);
        await program.parseAsync([
          "node",
          "mcpget",
          "install",
          "https://93.184.216.34/mcp",
          "codex",
          "--json",
          "--yes",
        ]);
        const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
          ok: boolean;
          command: string;
          error: { code: string; message: string };
          partial?: unknown;
        };
        expect(payload).toMatchObject({
          ok: false,
          command: "install",
          error: { code: "OPERATIONAL_FAILURE", message: detail },
        });
        expect(payload.partial).toBeDefined();
        expect(process.exitCode).toBe(1);
      } finally {
        if (stdinDescriptor)
          Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
        if (stdoutDescriptor)
          Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
        process.exitCode = 0;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
