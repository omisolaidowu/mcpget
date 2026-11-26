import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerManagementCommands } from "../../src/cli/commands/manage.js";
import { OperationJournal } from "../../src/installers/operation-journal.js";

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async () => process.env.MCPGET_TEST_CONFIRMATION ?? "y",
    close: vi.fn(),
  }),
}));

describe("Codex management commands without the Codex CLI", () => {
  const previousPath = process.env.PATH;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousPathext = process.env.PATHEXT;

  afterEach(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousPathext === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = previousPathext;
    delete process.env.MCPGET_TEST_CONFIRMATION;
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  it("lists, diagnoses, and removes Codex servers with an empty executable search path", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-codex-commands-"),
    );
    const emptyPath = path.join(directory, "empty-path");
    const configPath = path.join(directory, ".codex", "config.toml");
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
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(emptyPath, { recursive: true }),
      );
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(path.dirname(configPath), { recursive: true }),
      );
      await writeFile(
        configPath,
        [
          'model = "keep"',
          "",
          "[mcp_servers.sample]",
          'command = "node"',
          'args = ["server.js"]',
          "",
        ].join("\n"),
      );
      process.env.PATH = emptyPath;
      process.env.PATHEXT = "";
      process.env.CODEX_HOME = path.dirname(configPath);
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: true,
      });

      const createProgram = (): Command => {
        const program = new Command();
        registerManagementCommands(program);
        return program;
      };

      await createProgram().parseAsync(["node", "mcpget", "clients"]);
      expect(output.mock.calls.flat().join("\n")).toContain(
        "codex\tUser configuration present",
      );
      output.mockClear();

      await createProgram().parseAsync(["node", "mcpget", "list", "codex"]);
      expect(output.mock.calls.flat().join("\n")).toContain("sample\tcodex");
      output.mockClear();

      await createProgram().parseAsync(["node", "mcpget", "doctor", "codex"]);
      expect(output.mock.calls.flat().join("\n")).toContain(
        "configuration readable (1 MCP entries)",
      );
      expect(output.mock.calls.flat().join("\n")).toContain(
        "Codex CLI for optional OAuth login: not found",
      );
      expect(errors).not.toHaveBeenCalled();
      output.mockClear();

      await createProgram().parseAsync([
        "node",
        "mcpget",
        "remove",
        "sample",
        "codex",
      ]);
      const remaining = await readFile(configPath, "utf8");
      expect(remaining).toContain('model = "keep"');
      expect(remaining).not.toContain("[mcp_servers.sample]");
      expect(output.mock.calls.flat().join("\n")).toContain(
        "Removed sample from OpenAI Codex.",
      );
      expect(errors).not.toHaveBeenCalled();
    } finally {
      if (stdinDescriptor)
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      else
        delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
      if (stdoutDescriptor)
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      else
        delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean })
          .isTTY;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns JSON-only success responses for clients, list, and doctor", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-management-json-"),
    );
    const configPath = path.join(directory, ".codex", "config.toml");
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
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(path.dirname(configPath), { recursive: true }),
      );
      await writeFile(
        configPath,
        [
          "[mcp_servers.sample]",
          'command = "node"',
          'args = ["server.js"]',
          'env = { API_KEY = "never-output-this" }',
        ].join("\n"),
      );
      process.env.CODEX_HOME = path.dirname(configPath);
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: true,
      });

      const createProgram = (): Command => {
        const program = new Command();
        registerManagementCommands(program);
        return program;
      };

      await createProgram().parseAsync(["node", "mcpget", "clients", "--json"]);
      const clients = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        ok: boolean;
        command: string;
        data: { clients: unknown[] };
      };
      expect(clients).toMatchObject({ ok: true, command: "clients" });
      expect(clients.data.clients.length).toBeGreaterThan(0);
      output.mockClear();

      await createProgram().parseAsync([
        "node",
        "mcpget",
        "list",
        "codex",
        "--json",
      ]);
      const listed = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        ok: boolean;
        command: string;
        data: { count: number; servers: unknown[] };
      };
      expect(listed).toMatchObject({
        ok: true,
        command: "list",
        data: { count: 1 },
      });
      expect(JSON.stringify(listed)).not.toContain("never-output-this");
      output.mockClear();

      await createProgram().parseAsync([
        "node",
        "mcpget",
        "doctor",
        "codex",
        "--json",
      ]);
      const doctor = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        ok: boolean;
        command: string;
        data: { diagnostics: unknown[] };
      };
      expect(doctor).toMatchObject({ ok: true, command: "doctor" });
      expect(doctor.data.diagnostics.length).toBe(1);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      if (stdinDescriptor)
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      else
        delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
      if (stdoutDescriptor)
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      else
        delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean })
          .isTTY;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns structured JSON and exit 1 when doctor cannot read configuration", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-doctor-failure-"),
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
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: true,
      });
      const program = new Command();
      registerManagementCommands(program);
      await program.parseAsync(["node", "mcpget", "doctor", "codex", "--json"]);
      const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        ok: boolean;
        command: string;
        error: { code: string };
        partial: { diagnostics: unknown[] };
      };
      expect(payload).toMatchObject({
        ok: false,
        command: "doctor",
        error: { code: "OPERATIONAL_FAILURE" },
      });
      expect(payload.partial.diagnostics).toHaveLength(1);
      expect(errors).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    } finally {
      if (stdoutDescriptor)
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      else
        delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean })
          .isTTY;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lists both trusted Codex scopes and removes only the explicitly selected project entry", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-codex-project-management-"),
    );
    const codexHome = path.join(directory, "codex-home");
    const projectRoot = path.join(directory, "repo");
    const projectConfigPath = path.join(projectRoot, ".codex", "config.toml");
    const previousCwd = process.cwd();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(path.join(projectRoot, ".git"), { recursive: true }),
      );
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(path.dirname(projectConfigPath), { recursive: true }),
      );
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(codexHome, { recursive: true }),
      );
      await writeFile(
        path.join(codexHome, "config.toml"),
        [
          `[projects.${JSON.stringify(projectRoot)}]`,
          'trust_level = "trusted"',
          "",
          "[mcp_servers.user-server]",
          'command = "node"',
          'args = ["user.js"]',
          "",
        ].join("\n"),
      );
      await writeFile(
        projectConfigPath,
        [
          "[mcp_servers.project-server]",
          'command = "node"',
          'args = ["project.js"]',
          "",
        ].join("\n"),
      );
      process.env.CODEX_HOME = codexHome;
      process.chdir(projectRoot);

      const createProgram = (): Command => {
        const program = new Command();
        registerManagementCommands(program);
        return program;
      };
      await createProgram().parseAsync([
        "node",
        "mcpget",
        "list",
        "codex",
        "--json",
      ]);
      const listed = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        data: {
          count: number;
          servers: Array<{ name: string; scope: string; configPath: string }>;
        };
      };
      expect(listed.data.count).toBe(2);
      expect(listed.data.servers).toEqual(
        expect.arrayContaining([
          {
            name: "user-server",
            scope: "user",
            configPath: path.join(codexHome, "config.toml"),
            status: expect.any(String),
            client: "codex",
            configuration: expect.any(String),
          },
          {
            name: "project-server",
            scope: "project",
            configPath: projectConfigPath,
            status: expect.any(String),
            client: "codex",
            configuration: expect.any(String),
          },
        ]),
      );
      output.mockClear();

      await createProgram().parseAsync([
        "node",
        "mcpget",
        "remove",
        "project-server",
        "codex",
        "--config",
        projectConfigPath,
        "--yes",
        "--json",
      ]);
      expect(JSON.parse(output.mock.calls[0]?.[0] as string)).toMatchObject({
        ok: true,
        command: "remove",
        data: {
          scope: "project",
          configPath: projectConfigPath,
          removed: true,
        },
      });
      expect(await readFile(projectConfigPath, "utf8")).not.toContain(
        "[mcp_servers.project-server]",
      );
      expect(
        await readFile(path.join(codexHome, "config.toml"), "utf8"),
      ).toContain("[mcp_servers.user-server]");
      output.mockClear();

      await createProgram().parseAsync([
        "node",
        "mcpget",
        "doctor",
        "codex",
        "--config",
        projectConfigPath,
        "--json",
      ]);
      const doctor = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        data: {
          diagnostics: Array<{ configScope: string; configPath: string }>;
        };
      };
      expect(doctor.data.diagnostics).toEqual([
        expect.objectContaining({
          configScope: "project",
          configPath: projectConfigPath,
        }),
      ]);
    } finally {
      process.chdir(previousCwd);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports removal cancellation with exit 130 and no configuration change", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-remove-cancel-"),
    );
    const configPath = path.join(directory, ".codex", "config.toml");
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
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(path.dirname(configPath), { recursive: true }),
      );
      await writeFile(
        configPath,
        '[mcp_servers.sample]\ncommand = "node"\nargs = ["server.js"]\n',
      );
      process.env.CODEX_HOME = path.dirname(configPath);
      process.env.MCPGET_TEST_CONFIRMATION = "n";
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: true,
      });
      const program = new Command();
      registerManagementCommands(program);
      await program.parseAsync(["node", "mcpget", "remove", "sample", "codex"]);
      expect(output.mock.calls.flat().join("\n")).toContain(
        "Cancelled; no changes made.",
      );
      expect(process.exitCode).toBe(130);
      expect(await readFile(configPath, "utf8")).toContain(
        "[mcp_servers.sample]",
      );
      process.exitCode = 0;
    } finally {
      if (stdinDescriptor)
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      else
        delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
      if (stdoutDescriptor)
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      else
        delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean })
          .isTTY;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires --yes for non-interactive JSON removal and approves with --yes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mcpget-remove-json-"));
    const configPath = path.join(directory, ".codex", "config.toml");
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
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(path.dirname(configPath), { recursive: true }),
      );
      await writeFile(
        configPath,
        '[mcp_servers.sample]\ncommand = "node"\nargs = ["server.js"]\n',
      );
      process.env.CODEX_HOME = path.dirname(configPath);
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: false,
      });

      const program = new Command();
      registerManagementCommands(program);
      await program.parseAsync([
        "node",
        "mcpget",
        "remove",
        "sample",
        "codex",
        "--json",
      ]);
      const denied = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        ok: boolean;
        command: string;
        error: { code: string };
      };
      expect(denied).toMatchObject({
        ok: false,
        command: "remove",
        error: { code: "MISSING_REQUIRED_INPUT" },
      });
      expect(process.exitCode).toBe(4);
      expect(await readFile(configPath, "utf8")).toContain(
        "[mcp_servers.sample]",
      );

      process.exitCode = 0;
      output.mockClear();
      const approved = new Command();
      registerManagementCommands(approved);
      await approved.parseAsync([
        "node",
        "mcpget",
        "remove",
        "sample",
        "codex",
        "--json",
        "--yes",
      ]);
      const removed = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        ok: boolean;
        command: string;
        data: { removed: boolean; server: string };
      };
      expect(removed).toMatchObject({
        ok: true,
        command: "remove",
        data: { removed: true, server: "sample" },
      });
      expect(process.exitCode ?? 0).toBe(0);
      expect(await readFile(configPath, "utf8")).not.toContain(
        "[mcp_servers.sample]",
      );
    } finally {
      if (stdinDescriptor)
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      else
        delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
      if (stdoutDescriptor)
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      else
        delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean })
          .isTTY;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("blocks removal before creating a journal entry when backup artifacts exist", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-remove-backup-preflight-"),
    );
    const configPath = path.join(directory, ".codex", "config.toml");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const begin = vi.spyOn(OperationJournal.prototype, "begin");
    try {
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(path.dirname(configPath), { recursive: true }),
      );
      await writeFile(
        configPath,
        [
          "[mcp_servers.sample]",
          'command = "node"',
          'args = ["server.js"]',
          "",
        ].join("\n"),
      );
      await writeFile(`${configPath}.mcpget.bak`, "retained backup", {
        mode: 0o600,
      });
      process.env.CODEX_HOME = path.dirname(configPath);

      const program = new Command();
      registerManagementCommands(program);
      await program.parseAsync([
        "node",
        "mcpget",
        "remove",
        "sample",
        "codex",
        "--yes",
      ]);

      expect(begin).not.toHaveBeenCalled();
      expect(await readFile(configPath, "utf8")).toContain(
        "[mcp_servers.sample]",
      );
      expect(errors.mock.calls.flat().join("\n")).toMatch(/malformed TOML/i);
      expect(output).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = 0;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("archives a validated Codex backup through the explicit recovery option", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-recover-archive-cli-"),
    );
    const configPath = path.join(directory, ".codex", "config.toml");
    const backupPath = `${configPath}.mcpget.bak`;
    const active = [
      'model = "keep"',
      "",
      "[mcp_servers.sample]",
      'command = "node"',
      'args = ["new.js"]',
      "",
    ].join("\n");
    const original = [
      'model = "old"',
      "",
      "[mcp_servers.sample]",
      'command = "node"',
      'args = ["old.js"]',
      "",
    ].join("\n");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const resolutionStarted = vi
      .spyOn(OperationJournal.prototype, "beginBackupResolution")
      .mockImplementation(async (resolution) => ({
        schemaVersion: 1,
        id: "00000000-0000-4000-8000-000000000001",
        kind: "configuration_backup_resolution",
        action: "archive_orphaned_backup",
        status: "started",
        ...resolution,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
    const resolutionFinished = vi
      .spyOn(OperationJournal.prototype, "finishBackupResolution")
      .mockResolvedValue();
    vi.spyOn(OperationJournal.prototype, "list").mockResolvedValue([]);
    vi.spyOn(
      OperationJournal.prototype,
      "listBackupResolutions",
    ).mockResolvedValue([]);
    try {
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(path.dirname(configPath), { recursive: true }),
      );
      await writeFile(configPath, active);
      await writeFile(backupPath, original, { mode: 0o600 });
      process.env.CODEX_HOME = path.dirname(configPath);

      const program = new Command();
      registerManagementCommands(program);
      await program.parseAsync([
        "node",
        "mcpget",
        "recover",
        "--archive-orphaned-backup",
        "codex",
        "--yes",
        "--json",
      ]);

      const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        ok: boolean;
        command: string;
        data: { actions: Array<{ detail: string }> };
      };
      expect(payload).toMatchObject({
        ok: true,
        command: "recover",
        data: {
          actions: [
            {
              detail: expect.stringContaining(
                "active configuration was not changed",
              ),
            },
          ],
        },
      });
      expect(await readFile(configPath, "utf8")).toBe(active);
      await expect(readFile(backupPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const archived = (
        await import("node:fs/promises").then(({ readdir }) =>
          readdir(path.dirname(configPath)),
        )
      ).find((name) => name.includes(".mcpget.bak.archive."));
      expect(archived).toBeDefined();
      expect(
        await readFile(path.join(path.dirname(configPath), archived!), "utf8"),
      ).toBe(original);
      expect(resolutionStarted).toHaveBeenCalledOnce();
      expect(resolutionFinished).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000001",
        "completed",
      );
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
