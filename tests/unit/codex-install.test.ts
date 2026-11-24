import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../../src/installers/codex-adapter.js";

const mocks = vi.hoisted(() => ({
  findManagedNpm: vi.fn(),
  installManagedNpm: vi.fn(),
  managedInstallPath: vi.fn(),
  updateManagedMetadata: vi.fn(),
  verifyStdioMcp: vi.fn(),
  records: [] as unknown[],
}));

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({ question: async () => "y", close: vi.fn() }),
}));

vi.mock("../../src/installers/managed-npm.js", () => ({
  findManagedNpm: mocks.findManagedNpm,
  installManagedNpm: mocks.installManagedNpm,
  managedInstallPath: mocks.managedInstallPath,
  updateManagedMetadata: mocks.updateManagedMetadata,
}));

vi.mock("../../src/installers/state-store.js", () => ({
  InstallationStateStore: class {
    async all(): Promise<unknown[]> { return mocks.records; }
    async get(): Promise<undefined> { return undefined; }
    async put(record: unknown): Promise<void> { mocks.records.push(record); }
  },
}));

vi.mock("../../src/verification/mcp-connection.js", () => ({
  verifyStdioMcp: mocks.verifyStdioMcp,
  verifyHttpMcp: vi.fn(),
}));

import { registerInstallCommand } from "../../src/cli/commands/install.js";

describe("Codex installation without the Codex CLI", () => {
  const previousEnvironment = {
    path: process.env.PATH,
    pathext: process.env.PATHEXT,
    codexHome: process.env.CODEX_HOME,
  };
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

  afterEach(() => {
    if (previousEnvironment.path === undefined) delete process.env.PATH; else process.env.PATH = previousEnvironment.path;
    if (previousEnvironment.pathext === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = previousEnvironment.pathext;
    if (previousEnvironment.codexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousEnvironment.codexHome;
    if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    process.exitCode = 0;
    mocks.records.length = 0;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("installs, writes, and independently verifies Codex TOML while no CLI is on PATH", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mcpget-codex-install-"));
    const emptyPath = path.join(directory, "empty-path");
    const codexHome = path.join(directory, ".codex");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const wasStdinPaused = process.stdin.isPaused();
    try {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(emptyPath, { recursive: true }));
      process.env.PATH = emptyPath;
      process.env.PATHEXT = "";
      process.env.CODEX_HOME = codexHome;
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });

      mocks.findManagedNpm.mockResolvedValue(undefined);
      mocks.managedInstallPath.mockReturnValue(path.join(directory, "installation"));
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
      await program.parseAsync(["node", "mcpget", "install", "npm:@example/server", "codex"]);

      expect(errors).not.toHaveBeenCalled();
      expect(process.exitCode ?? 0).toBe(0);
      expect(output.mock.calls.flat().join("\n")).toContain("[COMPLETED] configured");
      expect(output.mock.calls.flat().join("\n")).toContain("[COMPLETED] connection_verified");
      expect(output.mock.calls.flat().join("\n")).toContain("AUTHENTICATION NOT VERIFIED");
      expect(mocks.records.length).toBeGreaterThan(1);
      expect(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(codexHome, "config.toml"), "utf8"))).toContain("[mcp_servers.");
    } finally {
      if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      if (wasStdinPaused) process.stdin.pause(); else process.stdin.resume();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports configuration failure without marking the completed installation or MCP check as failed", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mcpget-codex-config-failure-"));
    const emptyPath = path.join(directory, "empty-path");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const wasStdinPaused = process.stdin.isPaused();
    const addSpy = vi.spyOn(CodexAdapter.prototype, "add").mockRejectedValue(new Error("Synthetic configuration write failure."));
    try {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(emptyPath, { recursive: true }));
      process.env.PATH = emptyPath;
      process.env.PATHEXT = "";
      process.env.CODEX_HOME = path.join(directory, ".codex");
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });

      mocks.findManagedNpm.mockResolvedValue(undefined);
      mocks.managedInstallPath.mockReturnValue(path.join(directory, "installation"));
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
      await program.parseAsync(["node", "mcpget", "install", "npm:@example/server", "codex"]);

      const rendered = [...output.mock.calls, ...errors.mock.calls].flat().join("\n");
      expect(rendered).toContain("INSTALLATION COMPLETED; CLIENT CONFIGURATION FAILED; MCP PROTOCOL VERIFICATION COMPLETED; AUTHENTICATION NOT VERIFIED");
      expect(rendered).toContain("Configuration failed: Synthetic configuration write failure.");
      expect(rendered).not.toContain("Install failed:");
      expect(mocks.records).toHaveLength(4);
      expect(addSpy).toHaveBeenCalledOnce();
    } finally {
      if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      if (wasStdinPaused) process.stdin.pause(); else process.stdin.resume();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
