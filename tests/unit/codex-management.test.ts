import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerManagementCommands } from "../../src/cli/commands/manage.js";

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({ question: async () => "y", close: vi.fn() }),
}));

describe("Codex management commands without the Codex CLI", () => {
  const previousPath = process.env.PATH;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousPathext = process.env.PATHEXT;

  afterEach(() => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
    if (previousPathext === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = previousPathext;
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  it("lists, diagnoses, and removes Codex servers with an empty executable search path", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mcpget-codex-commands-"));
    const emptyPath = path.join(directory, "empty-path");
    const configPath = path.join(directory, ".codex", "config.toml");
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(emptyPath, { recursive: true }));
      await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(configPath), { recursive: true }));
      await writeFile(configPath, [
        'model = "keep"',
        "",
        "[mcp_servers.sample]",
        'command = "node"',
        'args = ["server.js"]',
        "",
      ].join("\n"));
      process.env.PATH = emptyPath;
      process.env.PATHEXT = "";
      process.env.CODEX_HOME = path.dirname(configPath);
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });

      const createProgram = (): Command => {
        const program = new Command();
        registerManagementCommands(program);
        return program;
      };

      await createProgram().parseAsync(["node", "mcpget", "clients"]);
      expect(output.mock.calls.flat().join("\n")).toContain("codex\tUser configuration present");
      output.mockClear();

      await createProgram().parseAsync(["node", "mcpget", "list", "codex"]);
      expect(output.mock.calls.flat().join("\n")).toContain("sample\tcodex");
      output.mockClear();

      await createProgram().parseAsync(["node", "mcpget", "doctor", "codex"]);
      expect(output.mock.calls.flat().join("\n")).toContain("configuration readable (1 MCP entries)");
      expect(output.mock.calls.flat().join("\n")).toContain("Codex CLI for optional OAuth login: not found");
      expect(errors).not.toHaveBeenCalled();
      output.mockClear();

      await createProgram().parseAsync(["node", "mcpget", "remove", "sample", "codex"]);
      const remaining = await readFile(configPath, "utf8");
      expect(remaining).toContain('model = "keep"');
      expect(remaining).not.toContain("[mcp_servers.sample]");
      expect(output.mock.calls.flat().join("\n")).toContain("Removed sample from OpenAI Codex.");
      expect(errors).not.toHaveBeenCalled();
    } finally {
      if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      else delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
      if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      else delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
