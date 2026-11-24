import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerInspectCommand } from "../../src/cli/commands/inspect.js";
import { registerPlaceholderCommands } from "../../src/cli/commands/placeholders.js";
import { registerSearchCommand } from "../../src/cli/commands/search.js";
import { safeTerminalText } from "../../src/cli/output.js";
import type { ServerCandidate } from "../../src/models/server-candidate.js";

function candidate(
  name: string,
  fields: Partial<ServerCandidate> = {},
): ServerCandidate {
  return {
    name,
    registryIdentifier: name,
    description: "Search and update Notion pages and databases.",
    operational: {
      deploymentModels: ["Remote endpoint"],
      transports: ["streamable-http"],
      packages: [],
      remoteEndpoints: ["https://mcp.notion.com/mcp"],
      configurationInputs: [],
      authentication: "Unknown",
      clientCompatibility: "Unknown",
      setupComplexity: "Unknown",
    },
    sourceRegistry: "Official MCP Registry",
    sourceRecordUrl: "https://registry.modelcontextprotocol.io/v0.1/servers/id/versions/1.0.0",
    ...fields,
  };
}

describe("placeholder commands", () => {
  it("registers only the still-pending command surface", () => {
    const program = new Command();
    registerPlaceholderCommands(program);
    expect(program.commands.map((command) => command.name())).toEqual([
      "add",
      "list",
      "remove",
      "doctor",
      "clients",
    ]);
  });

  it("clearly reports pending implementation", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerPlaceholderCommands(program);
    await program.parseAsync(["node", "mcpget", "doctor"]);
    expect(output).toHaveBeenCalledWith("This command is not implemented yet.");
    output.mockRestore();
  });
});

describe("terminal output", () => {
  it("removes control sequences from Registry text", () => {
    expect(safeTerminalText("name\u001b[31mRED\u0007\nnext")).toBe("name [31mRED next");
  });
});

describe("search command", () => {
  it("recommends a broad direct integration and displays separated evaluation dimensions", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerSearchCommand(program, {
      async searchByName() {
        return [candidate("com.vendor/notion", {
          title: "Notion Integration",
          description: "Search, read, create and update Notion pages, databases, and workspaces.",
          repositoryUrl: "https://github.com/vendor/notion-mcp",
        })];
      },
    });
    await program.parseAsync(["node", "mcpget", "search", "notion.com"]);
    const rendered = output.mock.calls.flat().join("\n");
    expect(rendered).toContain("RECOMMENDED");
    expect(rendered).toContain("Direct integration · High confidence");
    expect(rendered).toContain("trust Unverified");
    expect(rendered).toContain("Why selected:");
    expect(rendered).toContain("no candidate has been installed or executed");
    expect(rendered.length).toBeLessThan(1200);
    output.mockRestore();
  });

  it("hides unrelated candidates by default and includes them with --all", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const makeProgram = () => {
      const program = new Command();
      registerSearchCommand(program, {
        async searchByName() {
          return [
            candidate("com.vendor/notion", { title: "Notion" }),
            candidate("io.github.quietnotion/barevalue", {
              title: "Barevalue",
              description: "AI podcast editing and audio mastering.",
              operational: {
                deploymentModels: [], transports: [], packages: [], remoteEndpoints: [],
                configurationInputs: [], authentication: "Unknown", clientCompatibility: "Unknown",
                setupComplexity: "Unknown",
              },
            }),
          ];
        },
      });
      return program;
    };
    await makeProgram().parseAsync(["node", "mcpget", "search", "notion", "--all"]);
    expect(output.mock.calls.flat().join("\n")).toContain("Unrelated / false positive");
    output.mockClear();
    await makeProgram().parseAsync(["node", "mcpget", "search", "notion"]);
    expect(output.mock.calls.flat().join("\n")).toContain("1 unrelated hidden");
    expect(output.mock.calls.flat().join("\n")).not.toContain("Barevalue");
    output.mockRestore();
  });

  it("emits stable JSON without echoing the raw input URL", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerSearchCommand(program, {
      async searchByName() { return [candidate("com.vendor/notion", { title: "Notion MCP" })]; },
    });
    await program.parseAsync(["node", "mcpget", "search", "https://notion.com/path?token=secret", "--json"]);
    const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
      schemaVersion: number;
      service: { name: string; domain: string };
      candidates: Array<{ relevance: string; confidence: string; trust: string }>;
      safety: { installedOrExecuted: boolean };
    };
    expect(payload.schemaVersion).toBe(2);
    expect(payload.service).toEqual(expect.objectContaining({ name: "Notion", domain: "notion.so" }));
    expect(JSON.stringify(payload)).not.toContain("secret");
    expect(payload.candidates[0]).toMatchObject({
      relevance: "Direct integration",
      confidence: "High",
      trust: "Insufficient evidence",
    });
    expect(payload.safety.installedOrExecuted).toBe(false);
    output.mockRestore();
  });

  it("surfaces sensitive configuration concerns in compact output without showing values", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerSearchCommand(program, {
      async searchByName() {
        return [candidate("author/notion-token", {
          title: "Notion Workspace MCP",
          description: "Search, read, and update Notion pages and databases.",
          operational: {
            deploymentModels: ["Local package"], transports: ["stdio"], packages: [], remoteEndpoints: [],
            configurationInputs: [{
              name: "NOTION_TOKEN",
              required: true,
              secret: true,
              description: "Requires a browser token_v2 cookie.",
              deployment: "local-package",
            }],
            authentication: "Unknown", clientCompatibility: "Unknown", setupComplexity: "Unknown",
          },
        })];
      },
    });
    await program.parseAsync(["node", "mcpget", "search", "notion"]);
    const rendered = output.mock.calls.flat().join("\n");
    expect(rendered).toContain("Elevated concern");
    expect(rendered).toContain("browser-session credential");
    expect(rendered).not.toContain("NOTION_TOKEN=secret");
    output.mockRestore();
  });

  it("handles invalid input, no results, and Registry failures", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    registerSearchCommand(program, { async searchByName() { return []; } });
    await program.parseAsync(["node", "mcpget", "search", "ftp://notion.com"]);
    expect(errors.mock.calls.flat().join(" ")).toContain("Only http and https");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    errors.mockClear();
    await program.parseAsync(["node", "mcpget", "search", "notion.com"]);
    expect(output.mock.calls.flat().join("\n")).toContain("No candidates were returned");

    const failedProgram = new Command();
    registerSearchCommand(failedProgram, { async searchByName() { throw new Error("offline"); } });
    await failedProgram.parseAsync(["node", "mcpget", "search", "notion.com"]);
    expect(errors.mock.calls.flat().join(" ")).toContain("offline");
    process.exitCode = 0;
    output.mockRestore();
    errors.mockRestore();
  });
});

describe("inspect command", () => {
  it("fetches one Registry record and can evaluate it against a service", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerInspectCommand(program, {
      async getByIdentifier() {
        return candidate("com.notion/mcp", {
          title: "Notion MCP",
          description: "Search and update Notion pages.",
          websiteUrl: "https://mcp.notion.com/mcp",
        });
      },
    });
    await program.parseAsync(["node", "mcpget", "inspect", "com.notion/mcp", "--for", "notion.com"]);
    const rendered = output.mock.calls.flat().join("\n");
    expect(rendered).toContain("Registry identifier: com.notion/mcp");
    expect(rendered).toContain("Relevance: Direct integration");
    expect(rendered).toContain("Match confidence: High");
    expect(rendered).toContain("Authentication: Unknown");
    output.mockRestore();
  });
});
