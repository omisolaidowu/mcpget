import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerInspectCommand } from "../../src/cli/commands/inspect.js";
import {
  formatCandidateSelectionLines,
  formatDuplicateWarnings,
  registerInstallCommand,
  selectInstallableCandidate,
  type CandidateSelectionPresentation,
} from "../../src/cli/commands/install.js";
import { registerPlaceholderCommands } from "../../src/cli/commands/placeholders.js";
import { registerSearchCommand } from "../../src/cli/commands/search.js";
import { safeTerminalText } from "../../src/cli/output.js";
import { evaluateCandidates } from "../../src/discovery/evaluate-candidates.js";
import { resolveServiceIdentity } from "../../src/discovery/url-resolver.js";
import { packageVersion } from "../../src/package-version.js";
import type { ServerCandidate } from "../../src/models/server-candidate.js";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

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
    sourceRecordUrl:
      "https://registry.modelcontextprotocol.io/v0.1/servers/id/versions/1.0.0",
    ...fields,
  };
}

function localPackageCandidate(
  name: string,
  description: string,
  packageIdentifier: string,
  version: string,
): ServerCandidate {
  return candidate(name, {
    title: name,
    description,
    version,
    operational: {
      deploymentModels: ["Local package"],
      transports: ["stdio"],
      packages: [
        {
          registryType: "npm",
          identifier: packageIdentifier,
          version,
        },
      ],
      remoteEndpoints: [],
      configurationInputs: [],
      authentication: "Unknown",
      clientCompatibility: "Unknown",
      setupComplexity: "Unknown",
    },
  });
}

function containsTerminalControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code <= 0x1f && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
  });
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
    expect(safeTerminalText("name\u001b[31mRED\u0007\nnext")).toBe(
      "name [31mRED next",
    );
  });

  it("strips ANSI and OSC controls while preserving readable text", () => {
    const text = safeTerminalText(
      "Readable\u001b[2J\u001b]52;c;clipboard-data\u0007 text\u009d8;;https://evil.test\u009c",
    );
    expect(text).toContain("Readable");
    expect(text).toContain("text");
    expect(containsTerminalControl(text)).toBe(false);
  });

  it("sanitizes duplicate presentation fields at the terminal boundary", () => {
    const lines = formatCandidateSelectionLines(["choice"], {
      heading: ["Possible duplicates\u001b[2J"],
      labels: ["Registry entry\u001b]8;;https://evil.test\u0007"],
      details: ["v1.0.0\u001b[31m"],
      footer: [
        "Shared package: @example/server\u009d8;;https://evil.test\u009c",
      ],
    });

    expect(containsTerminalControl(lines.join("\n"))).toBe(false);
    expect(lines[0]).toContain("Possible duplicates");
    expect(lines[1]).toContain("Registry entry");
    expect(lines[2]).toContain("v1.0.0");
    expect(lines[3]).toContain("Shared package: @example/server");
  });
});

describe("shared domain search normalization", () => {
  it("uses the same hostname term for search and every client install", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcpget-domain-search-"));
    const previousClaudePath = process.env.MCPGET_CLAUDE_CONFIG_PATH;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.MCPGET_CLAUDE_CONFIG_PATH = join(
      directory,
      "claude",
      "config.json",
    );
    process.env.CODEX_HOME = join(directory, "codex");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const searchTerms: string[] = [];
      const searchProgram = new Command();
      registerSearchCommand(searchProgram, {
        async searchByName(term) {
          searchTerms.push(term);
          return [];
        },
      });
      await searchProgram.parseAsync([
        "node",
        "mcpget",
        "search",
        "github.com",
        "--json",
      ]);
      expect(searchTerms).toEqual(["github"]);

      for (const client of ["claude", "cursor", "codex"]) {
        const installTerms: string[] = [];
        const installProgram = new Command();
        registerInstallCommand(installProgram, {
          async searchByName(term) {
            installTerms.push(term);
            return [];
          },
        });
        await installProgram.parseAsync([
          "node",
          "mcpget",
          "install",
          "github.com",
          client,
          "--json",
        ]);
        expect(installTerms).toEqual(searchTerms);
        process.exitCode = 0;
      }
    } finally {
      if (previousClaudePath === undefined)
        delete process.env.MCPGET_CLAUDE_CONFIG_PATH;
      else process.env.MCPGET_CLAUDE_CONFIG_PATH = previousClaudePath;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      output.mockRestore();
      errors.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("partial discovery during installation", () => {
  it("prompts for an explicit choice when partial discovery returns one candidate", async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const candidateSelector = vi.fn(
      async (question: string, choices: string[]) => {
        expect(question).toBe("Select this candidate to continue:");
        expect(choices).toHaveLength(1);
        return "not selected";
      },
    );
    const server = localPackageCandidate(
      "com.vendor/notion",
      "Search and update Notion pages and databases.",
      "@vendor/notion-mcp",
      "1.0.0",
    );
    try {
      registerInstallCommand(
        program,
        {
          async searchByName() {
            return [server];
          },
          async searchByNameWithMetadata() {
            return {
              candidates: [server],
              status: "partial" as const,
              terminationReason: "page_limit_reached" as const,
              pagesFetched: 100,
              safetyLimitReached: true,
            };
          },
        },
        candidateSelector,
      );
      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "notion.com",
        "claude",
        "--json",
      ]);

      expect(candidateSelector).toHaveBeenCalledOnce();
      expect(output).toHaveBeenCalledOnce();
      expect(JSON.parse(output.mock.calls[0]?.[0] as string)).toMatchObject({
        ok: false,
        partial: {
          discovery: {
            status: "partial",
            safetyLimitReached: true,
          },
        },
      });
    } finally {
      if (stdinDescriptor)
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      else Reflect.deleteProperty(process.stdin, "isTTY");
      if (stdoutDescriptor)
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      else Reflect.deleteProperty(process.stdout, "isTTY");
      output.mockRestore();
    }
  });

  it.each(["claude", "cursor", "codex"])(
    "requires explicit candidate selection for partial %s discovery",
    async (client) => {
      const program = new Command();
      const output = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      const errors = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const source = {
        async searchByName() {
          return [
            localPackageCandidate(
              "com.vendor/notion",
              "Search and update Notion pages and databases.",
              "@vendor/notion-mcp",
              "1.0.0",
            ),
          ];
        },
        async searchByNameWithMetadata() {
          return {
            candidates: [
              localPackageCandidate(
                "com.vendor/notion",
                "Search and update Notion pages and databases.",
                "@vendor/notion-mcp",
                "1.0.0",
              ),
            ],
            status: "partial" as const,
            terminationReason: "page_limit_reached" as const,
            pagesFetched: 100,
            safetyLimitReached: true,
          };
        },
      };
      registerInstallCommand(program, source);
      await program.parseAsync([
        "node",
        "mcpget",
        "install",
        "notion.com",
        client,
        "--json",
      ]);

      const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        ok: boolean;
        error: { message: string };
        warnings: string[];
        partial: {
          discovery: {
            status: string;
            pagesFetched: number;
            safetyLimitReached: boolean;
          };
        };
      };
      expect(payload.ok).toBe(false);
      expect(payload.error.message).toContain("--candidate <registry-id>");
      expect(payload.error.message).toContain(
        "additional candidates may exist",
      );
      expect(payload.warnings).toContain(
        "Registry discovery reached the 100-page safety limit. Showing the strongest matches found so far; additional candidates may exist.",
      );
      expect(payload.partial.discovery).toEqual({
        status: "partial",
        terminationReason: "page_limit_reached",
        pagesFetched: 100,
        safetyLimitReached: true,
      });
      expect(errors).not.toHaveBeenCalled();
      output.mockRestore();
      errors.mockRestore();
    },
  );
});

describe("install duplicate candidate selection", () => {
  function evaluations(candidates: ServerCandidate[]) {
    return evaluateCandidates(
      resolveServiceIdentity("thunderbit.com"),
      candidates,
    ).evaluations;
  }

  function duplicateCandidates(): ServerCandidate[] {
    return [
      localPackageCandidate(
        "io.github.thunderbit-com/thunderbit-mcp-server",
        "AI-powered web scraping MCP. Distill pages to Markdown.",
        "@thunderbit/mcp-server",
        "1.0.4",
      ),
      localPackageCandidate(
        "io.github.thunderbit-open/thunderbit-mcp-server",
        "AI-powered web scraping MCP. Distill pages to Markdown.",
        "@thunderbit/mcp-server",
        "1.0.3",
      ),
    ];
  }

  async function capturePresentation(
    evaluated: ReturnType<typeof evaluations>,
  ) {
    let presentation: CandidateSelectionPresentation | undefined;
    let choices: string[] = [];
    await selectInstallableCandidate(
      evaluated,
      evaluated,
      async (_question, availableChoices, selectionPresentation) => {
        choices = availableChoices;
        presentation = selectionPresentation;
        return availableChoices[0]!;
      },
    );
    return {
      choices,
      presentation,
      lines: formatCandidateSelectionLines(choices, presentation),
    };
  }

  it("associates Registry versions with candidates and lists the shared package once", async () => {
    const evaluated = evaluations(duplicateCandidates());
    let presentation: CandidateSelectionPresentation | undefined;
    let choices: string[] = [];
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const selected = await selectInstallableCandidate(
      evaluated,
      evaluated,
      async (question, availableChoices, selectionPresentation) => {
        expect(question).toBe("Choose a candidate (1–2):");
        choices = availableChoices;
        presentation = selectionPresentation;
        return availableChoices[1]!;
      },
    );

    expect(selected.registryIdentifier).toBe(
      "io.github.thunderbit-open/thunderbit-mcp-server",
    );
    expect(choices).toEqual([
      "io.github.thunderbit-com/thunderbit-mcp-server — io.github.thunderbit-com/thunderbit-mcp-server",
      "io.github.thunderbit-open/thunderbit-mcp-server — io.github.thunderbit-open/thunderbit-mcp-server",
    ]);
    expect(presentation?.heading).toEqual([
      "Possible duplicate entries (2)",
      "These Registry entries share the same npm package and may represent the same integration; this is suggestive metadata, not a security verdict.",
    ]);
    const lines = formatCandidateSelectionLines(choices, presentation);
    expect(lines).toEqual([
      "Possible duplicate entries (2)",
      "These Registry entries share the same npm package and may represent the same integration; this is suggestive metadata, not a security verdict.",
      "  1. io.github.thunderbit-com/thunderbit-mcp-server",
      "     v1.0.4 · Newer Registry version",
      "  2. io.github.thunderbit-open/thunderbit-mcp-server",
      "     v1.0.3",
      "Shared package: @thunderbit/mcp-server",
    ]);
    expect(
      lines.filter((line) => line.includes("Shared package:")),
    ).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("reports candidate identity and duplicate metadata in the existing JSON error envelope", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    registerInstallCommand(program, {
      async searchByName() {
        return duplicateCandidates();
      },
    });

    await program.parseAsync([
      "node",
      "mcpget",
      "install",
      "thunderbit.com",
      "codex",
      "--json",
    ]);

    const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
      schemaVersion: number;
      ok: boolean;
      command: string;
      error: { code: string; message: string };
      warnings: string[];
    };
    expect(Object.keys(payload)).toEqual([
      "schemaVersion",
      "ok",
      "command",
      "error",
      "warnings",
    ]);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      ok: false,
      command: "install",
      error: { code: "INVALID_INPUT" },
    });
    expect(payload.error.message).toContain(
      "io.github.thunderbit-com/thunderbit-mcp-server",
    );
    expect(payload.error.message).toContain(
      "io.github.thunderbit-open/thunderbit-mcp-server",
    );
    expect(payload.error.message).toContain("npm:@thunderbit/mcp-server");
    expect(payload.error.message).toContain(
      "Version comparison: 1.0.4 appears newer than 1.0.3.",
    );
    expect(errors).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
    output.mockRestore();
    errors.mockRestore();
  });

  it("returns no duplicate warning for independent candidates", () => {
    const candidates = [
      localPackageCandidate(
        "io.github.thunderbit/server-a",
        "A web scraping MCP server.",
        "@thunderbit/server-a",
        "1.0.0",
      ),
      localPackageCandidate(
        "io.github.thunderbit/server-b",
        "A different web scraping MCP server.",
        "@thunderbit/server-b",
        "1.0.0",
      ),
    ];
    const evaluated = evaluations(candidates);
    expect(formatDuplicateWarnings(evaluated)).toEqual([]);
  });

  it("preserves the original numbered-choice rendering without duplicate metadata", () => {
    expect(
      formatCandidateSelectionLines([
        "io.github.vendor/server — Example server",
      ]),
    ).toEqual(["  1. io.github.vendor/server — Example server"]);
  });

  it("shows individual Registry versions without a newer label when comparison is unavailable or ambiguous", async () => {
    const unavailableComparison = evaluations([
      localPackageCandidate(
        "io.github.thunderbit/stable-one",
        "A web scraping MCP server.",
        "@thunderbit/stable",
        "stable",
      ),
      localPackageCandidate(
        "io.github.thunderbit/stable-two",
        "Another web scraping MCP server.",
        "@thunderbit/stable",
        "1.0.0",
      ),
    ]);
    const unavailableLines = (await capturePresentation(unavailableComparison))
      .lines;

    expect(unavailableLines).toContain("     vstable");
    expect(unavailableLines).toContain("     v1.0.0");
    expect(
      unavailableLines.some((line) => line.includes("Newer Registry version")),
    ).toBe(false);

    const ambiguousComparison = evaluations([
      localPackageCandidate(
        "io.github.thunderbit/equal-one",
        "A web scraping MCP server.",
        "@thunderbit/equal",
        "1.0.0",
      ),
      localPackageCandidate(
        "io.github.thunderbit/equal-two",
        "Another web scraping MCP server.",
        "@thunderbit/equal",
        "1.0.0",
      ),
    ]);
    const ambiguousLines = (await capturePresentation(ambiguousComparison))
      .lines;
    expect(
      ambiguousLines.filter((line) => line === "     v1.0.0"),
    ).toHaveLength(2);
    expect(
      ambiguousLines.some((line) => line.includes("Newer Registry version")),
    ).toBe(false);
  });

  it("renders multiple duplicate groups with their own shared packages", async () => {
    const candidates = [
      localPackageCandidate(
        "io.github.thunderbit/group-a-one",
        "A web scraping MCP server.",
        "@thunderbit/group-a",
        "1.0.0",
      ),
      localPackageCandidate(
        "io.github.thunderbit/group-a-two",
        "Another web scraping MCP server.",
        "@thunderbit/group-a",
        "1.0.1",
      ),
      localPackageCandidate(
        "io.github.thunderbit/group-b-one",
        "A third web scraping MCP server.",
        "@thunderbit/group-b",
        "2.0.0",
      ),
      localPackageCandidate(
        "io.github.thunderbit/group-b-two",
        "A fourth web scraping MCP server.",
        "@thunderbit/group-b",
        "2.0.1",
      ),
    ];
    const evaluated = evaluations(candidates);
    const { lines } = await capturePresentation(evaluated);

    expect(lines[0]).toBe("Possible duplicate entries (4)");
    expect(lines).toContain(
      "Group 1: Shared package: @thunderbit/group-a (candidates 1, 2)",
    );
    expect(lines).toContain(
      "Group 2: Shared package: @thunderbit/group-b (candidates 3, 4)",
    );
    expect(
      lines.filter((line) => line.includes("Shared package:")),
    ).toHaveLength(2);
    expect(evaluated).toHaveLength(4);
  });

  it("leaves search duplicate presentation unchanged", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerSearchCommand(program, {
      async searchByName() {
        return duplicateCandidates();
      },
    });

    await program.parseAsync(["node", "mcpget", "search", "thunderbit.com"]);

    const rendered = output.mock.calls.flat().join("\n");
    expect(rendered).toContain("Candidates for review (2)");
    expect(rendered).toContain("Possible duplicate of");
    expect(rendered).toContain("Version comparison:");
    expect(rendered).not.toContain("Possible duplicate entries (2)");
    expect(rendered).not.toContain("Choose a candidate");
  });
});

describe("search command", () => {
  it("labels a registry-ranked candidate without implying endorsement", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const source = {
      async searchByName() {
        return [
          candidate("com.vendor/notion", {
            title: "Notion Integration",
            description:
              "Search, read, create and update Notion pages, databases, and workspaces.",
            repositoryUrl: "https://github.com/vendor/notion-mcp",
          }),
        ];
      },
    };
    registerSearchCommand(program, source);
    await program.parseAsync(["node", "mcpget", "search", "notion.com"]);
    const rendered = output.mock.calls.flat().join("\n");
    expect(rendered).toContain("TOP CANDIDATE — not an endorsement");
    expect(rendered).toContain("Direct integration · High confidence");
    expect(rendered).toContain("trust Unverified");
    expect(rendered).toContain("Why ranked first:");
    expect(rendered).toContain(
      "Trust, security, and runtime behavior are not independently verified",
    );
    expect(rendered.length).toBeLessThan(1200);

    const jsonProgram = new Command();
    registerSearchCommand(jsonProgram, source);
    output.mockClear();
    await jsonProgram.parseAsync([
      "node",
      "mcpget",
      "search",
      "notion.com",
      "--json",
    ]);
    const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
      data: { recommendation: { status: string; candidateId?: string } };
    };
    expect(payload.data.recommendation).toMatchObject({
      status: "candidate",
      candidateId: "com.vendor/notion",
    });
    output.mockRestore();
  });

  it("warns when partial discovery returns ranked candidates and exposes JSON metadata", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const directCandidate = candidate("com.vendor/notion", {
      title: "Notion Integration",
      description:
        "Search, read, create and update Notion pages, databases, and workspaces.",
    });
    const source = {
      async searchByName() {
        return [directCandidate, directCandidate];
      },
      async searchByNameWithMetadata() {
        return {
          candidates: [directCandidate, directCandidate],
          status: "partial" as const,
          terminationReason: "page_limit_reached" as const,
          pagesFetched: 100,
          safetyLimitReached: true,
        };
      },
    };
    registerSearchCommand(program, source);
    await program.parseAsync([
      "node",
      "mcpget",
      "search",
      "notion.com",
      "--json",
    ]);

    const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
      warnings: string[];
      data: {
        discovery: {
          status: string;
          terminationReason: string;
          pagesFetched: number;
          safetyLimitReached: boolean;
        };
        summary: { discoveredCandidates: number; returnedCandidates: number };
        candidates: Array<{ confidence: string; relevance: string }>;
        recommendation: { status: string };
      };
    };
    expect(payload.data.discovery).toEqual({
      status: "partial",
      terminationReason: "page_limit_reached",
      pagesFetched: 100,
      safetyLimitReached: true,
    });
    expect(payload.warnings).toContain(
      "Registry discovery reached the 100-page safety limit. Showing the strongest matches found so far; additional candidates may exist.",
    );
    expect(payload.data.summary).toMatchObject({
      discoveredCandidates: 1,
      returnedCandidates: 1,
    });
    expect(payload.data.candidates[0]).toMatchObject({
      confidence: "High",
      relevance: "Direct integration",
    });
    expect(payload.data.recommendation.status).toBe("candidate");
    output.mockRestore();
  });

  it("explains empty partial discovery and recommends a narrower search", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const source = {
      async searchByName() {
        return [];
      },
      async searchByNameWithMetadata() {
        return {
          candidates: [],
          status: "partial" as const,
          terminationReason: "page_limit_reached" as const,
          pagesFetched: 100,
          safetyLimitReached: true,
        };
      },
    };
    registerSearchCommand(program, source);
    await program.parseAsync(["node", "mcpget", "search", "notion.com"]);
    const rendered = output.mock.calls.flat().join("\n");
    expect(rendered).toContain(
      "Registry discovery reached the 100-page safety limit.",
    );
    expect(rendered).toContain(
      "No useful candidates were retrieved before discovery became incomplete.",
    );
    expect(rendered).toContain("Try a more specific service name.");

    const jsonProgram = new Command();
    registerSearchCommand(jsonProgram, source);
    await jsonProgram.parseAsync([
      "node",
      "mcpget",
      "search",
      "notion.com",
      "--json",
    ]);
    const payload = JSON.parse(
      output.mock.calls[output.mock.calls.length - 1]?.[0] as string,
    ) as {
      warnings: string[];
      data: { discovery: { status: string }; candidates: unknown[] };
    };
    expect(payload.data.discovery.status).toBe("partial");
    expect(payload.data.candidates).toEqual([]);
    expect(payload.warnings).toContain(
      "No useful candidates were retrieved before discovery became incomplete. Try a more specific service name.",
    );
    output.mockRestore();
  });

  it("lists related candidates for review when no recommendation is eligible", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerSearchCommand(program, {
      async searchByName() {
        return [
          localPackageCandidate(
            "io.github.vendor/thunderbit-mcp-server",
            "AI-powered web scraping MCP. Distill pages to Markdown.",
            "@thunderbit/mcp-server",
            "1.0.4",
          ),
          candidate("io.github.vendor/thunderbit/mcp", {
            title: "Thunderbit MCP",
            description: "Thunderbit MCP server for pages.",
            operational: {
              deploymentModels: ["Local package"],
              transports: ["stdio"],
              packages: [
                {
                  registryType: "npm",
                  identifier: "@thunderbit/direct",
                  version: "1.0.0",
                },
              ],
              remoteEndpoints: ["https://api.thunderbit.com/mcp"],
              configurationInputs: [],
              authentication: "Unknown",
              clientCompatibility: "Unknown",
              setupComplexity: "Unknown",
            },
          }),
        ];
      },
    });

    await program.parseAsync(["node", "mcpget", "search", "thunderbit.com"]);

    const rendered = output.mock.calls.flat().join("\n");
    expect(rendered).toContain("NO RECOMMENDATION");
    expect(rendered).toContain("Candidates for review (2)");
    expect(rendered).toContain(
      "Registry identity: io.github.vendor/thunderbit-mcp-server",
    );
    expect(rendered).toContain(
      "Available installation source: npm:@thunderbit/mcp-server (version 1.0.4)",
    );
    expect(rendered).toContain("Related integration · Medium match confidence");
    expect(rendered).toContain("Direct integration · High match confidence");
    expect(rendered).toContain("io.github.vendor/thunderbit/mcp");
    expect(rendered).not.toContain("RECOMMENDED FOR CONSIDERATION");
    expect(rendered).not.toContain("more available");
    output.mockRestore();
  });

  it("keeps a recommendation prominent and lists related matches separately", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerSearchCommand(program, {
      async searchByName() {
        return [
          candidate("com.vendor/notion", {
            title: "Notion Integration",
            description:
              "Search, read, create and update Notion pages, databases, and workspaces.",
          }),
          localPackageCandidate(
            "io.github.vendor/notion-helper",
            "A lightweight Notion connection helper.",
            "@vendor/notion-helper",
            "1.0.0",
          ),
        ];
      },
    });

    await program.parseAsync(["node", "mcpget", "search", "notion.com"]);

    const rendered = output.mock.calls.flat().join("\n");
    expect(rendered).toContain("TOP CANDIDATE — not an endorsement");
    expect(rendered).toContain("Notion Integration");
    expect(rendered).toContain("Related alternatives for review (1)");
    expect(rendered).toContain(
      "Registry identity: io.github.vendor/notion-helper",
    );
    expect(rendered).toContain("Related integration · Medium match confidence");
    output.mockRestore();
  });

  it("does not promote installable unrelated candidates into review results", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const unrelated = localPackageCandidate(
      "io.github.vendor/audio-tool",
      "Podcast editing and audio mastering utilities.",
      "@vendor/audio-tool",
      "1.0.0",
    );
    const source = {
      async searchByName() {
        return [unrelated];
      },
    };

    registerSearchCommand(program, source);
    await program.parseAsync(["node", "mcpget", "search", "notion"]);
    const defaultOutput = output.mock.calls.flat().join("\n");
    expect(defaultOutput).toContain("1 unrelated excluded");
    expect(defaultOutput).not.toContain("Candidates for review");
    expect(defaultOutput).not.toContain("io.github.vendor/audio-tool");

    const allProgram = new Command();
    registerSearchCommand(allProgram, source);
    output.mockClear();
    await allProgram.parseAsync([
      "node",
      "mcpget",
      "search",
      "notion",
      "--all",
    ]);
    const allOutput = output.mock.calls.flat().join("\n");
    expect(allOutput).toContain("Unrelated candidates (--all) (1)");
    expect(allOutput).not.toContain("unrelated hidden");
    expect(allOutput).toContain("io.github.vendor/audio-tool");
    output.mockRestore();
  });

  it("shows both possible duplicates and keeps counts accurate with --more", async () => {
    const source = {
      async searchByName() {
        return [
          localPackageCandidate(
            "io.github.vendor-a/thunderbit-mcp-server",
            "AI-powered web scraping MCP. Distill pages to Markdown.",
            "@thunderbit/mcp-server",
            "1.0.4",
          ),
          localPackageCandidate(
            "io.github.vendor-b/thunderbit-mcp-server",
            "AI-powered web scraping MCP. Distill pages to Markdown.",
            "@thunderbit/mcp-server",
            "1.0.3",
          ),
        ];
      },
    };
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerSearchCommand(program, source);
    await program.parseAsync(["node", "mcpget", "search", "thunderbit.com"]);

    const compact = output.mock.calls.flat().join("\n");
    expect(compact).toContain("Candidates for review (2)");
    expect(compact).toContain("io.github.vendor-a/thunderbit-mcp-server");
    expect(compact).toContain("io.github.vendor-b/thunderbit-mcp-server");
    expect(compact.match(/Possible duplicate of/g)).toHaveLength(2);
    expect(compact).not.toContain("2 more available");

    const moreProgram = new Command();
    registerSearchCommand(moreProgram, source);
    output.mockClear();
    await moreProgram.parseAsync([
      "node",
      "mcpget",
      "search",
      "thunderbit.com",
      "--more",
    ]);
    const expanded = output.mock.calls.flat().join("\n");
    expect(expanded).toContain("Candidates for review (2)");
    expect(expanded).toContain("AI-powered web scraping MCP.");
    expect(expanded.match(/Registry identity:/g)).toHaveLength(2);
    expect(expanded.match(/Possible duplicate of/g)).toHaveLength(2);
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
                deploymentModels: [],
                transports: [],
                packages: [],
                remoteEndpoints: [],
                configurationInputs: [],
                authentication: "Unknown",
                clientCompatibility: "Unknown",
                setupComplexity: "Unknown",
              },
            }),
          ];
        },
      });
      return program;
    };
    await makeProgram().parseAsync([
      "node",
      "mcpget",
      "search",
      "notion",
      "--all",
    ]);
    expect(output.mock.calls.flat().join("\n")).toContain(
      "Unrelated / false positive",
    );
    output.mockClear();
    await makeProgram().parseAsync(["node", "mcpget", "search", "notion"]);
    expect(output.mock.calls.flat().join("\n")).toContain(
      "1 unrelated excluded",
    );
    expect(output.mock.calls.flat().join("\n")).not.toContain("Barevalue");
    output.mockRestore();
  });

  it("emits stable JSON without echoing the raw input URL", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerSearchCommand(program, {
      async searchByName() {
        return [candidate("com.vendor/notion", { title: "Notion MCP" })];
      },
    });
    await program.parseAsync([
      "node",
      "mcpget",
      "search",
      "https://notion.com/path?token=secret",
      "--json",
    ]);
    const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
      schemaVersion: number;
      ok: boolean;
      command: string;
      data: {
        schemaVersion: number;
        service: { name: string; domain: string };
        candidates: Array<{
          relevance: string;
          confidence: string;
          trust: string;
          capabilities: {
            inferredFromDescription: string[];
            registryDeclared: string[];
            independentlyVerified: string[];
          };
        }>;
        safety: {
          capabilitiesVerified: boolean;
          securityAudited: boolean;
          installedOrExecuted: boolean;
        };
      };
    };
    expect(payload).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "search",
    });
    expect(payload.data.schemaVersion).toBe(3);
    expect(payload.data.service).toEqual(
      expect.objectContaining({ name: "Notion", domain: "notion.so" }),
    );
    expect(JSON.stringify(payload)).not.toContain("secret");
    expect(payload.data.candidates[0]).toMatchObject({
      relevance: "Direct integration",
      confidence: "High",
      trust: "Insufficient evidence",
    });
    expect(
      payload.data.candidates[0]?.capabilities.inferredFromDescription.length,
    ).toBeGreaterThan(0);
    expect(
      payload.data.candidates[0]?.capabilities.independentlyVerified,
    ).toEqual([]);
    expect(payload.data.safety).toMatchObject({
      capabilitiesVerified: false,
      securityAudited: false,
      installedOrExecuted: false,
    });
    output.mockRestore();
  });

  it("uses the compact JSON schema when no candidate qualifies", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerSearchCommand(program, {
      async searchByName() {
        return [
          localPackageCandidate(
            "io.github.vendor/thunderbit-mcp-server",
            "AI-powered web scraping MCP. Distill pages to Markdown.",
            "@thunderbit/mcp-server",
            "1.0.4",
          ),
        ];
      },
    });
    await program.parseAsync([
      "node",
      "mcpget",
      "search",
      "thunderbit.com",
      "--json",
    ]);

    const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
      data: Record<string, unknown> & {
        recommendation: { status: string };
        candidates: Array<{ registryIdentifier: string }>;
        summary: {
          discoveredCandidates: number;
          matchedCandidates: number;
          returnedCandidates: number;
          omittedCandidates: number;
          excludedUnrelatedCandidates: number;
        };
      };
    };
    expect(Object.keys(payload.data)).toEqual([
      "schemaVersion",
      "service",
      "summary",
      "discovery",
      "recommendation",
      "candidates",
      "safety",
    ]);
    expect(payload.data.schemaVersion).toBe(3);
    expect(payload.data.recommendation.status).toBe("no_recommendation");
    expect(payload.data.summary).toEqual({
      discoveredCandidates: 1,
      matchedCandidates: 1,
      returnedCandidates: 1,
      omittedCandidates: 0,
      excludedUnrelatedCandidates: 0,
    });
    expect(payload.data.candidates).toEqual([
      expect.objectContaining({
        registryIdentifier: "io.github.vendor/thunderbit-mcp-server",
      }),
    ]);
    output.mockRestore();
  });

  it("defaults to five ranked candidates and applies explicit limits after discovery", async () => {
    const candidates = Array.from({ length: 7 }, (_, index) =>
      candidate(`io.github.vendor/notion-${index}`, {
        title: `Notion Server ${index}`,
        description: "Search and update Notion pages and databases.",
      }),
    );
    candidates.push(
      candidate("io.github.vendor/notion-best", {
        title: "Notion Comprehensive",
        description:
          "Search, read, create, update, delete, share Notion pages, databases, workspaces, and files.",
      }),
    );
    const metadataSearch = vi.fn(async () => ({
      candidates,
      status: "complete" as const,
      terminationReason: "cursor_exhausted" as const,
      pagesFetched: 2,
      safetyLimitReached: false,
    }));
    const source = {
      async searchByName() {
        return candidates;
      },
      searchByNameWithMetadata: metadataSearch,
    };
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const program = new Command();
    registerSearchCommand(program, source);
    await program.parseAsync([
      "node",
      "mcpget",
      "search",
      "notion.com",
      "--json",
    ]);

    const defaultPayload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
      data: {
        summary: Record<string, number>;
        candidates: Array<{ registryIdentifier: string }>;
        recommendation: { status: string; candidateId?: string };
        discovery: { status: string; pagesFetched: number };
      };
    };
    expect(defaultPayload.data.summary).toEqual({
      discoveredCandidates: 8,
      matchedCandidates: 8,
      returnedCandidates: 5,
      omittedCandidates: 3,
      excludedUnrelatedCandidates: 0,
    });
    expect(defaultPayload.data.candidates).toHaveLength(5);
    expect(defaultPayload.data.candidates[0]?.registryIdentifier).toBe(
      "io.github.vendor/notion-best",
    );
    expect(defaultPayload.data.recommendation.candidateId).toBe(
      "io.github.vendor/notion-best",
    );
    expect(defaultPayload.data.discovery).toEqual({
      status: "complete",
      terminationReason: "cursor_exhausted",
      pagesFetched: 2,
      safetyLimitReached: false,
    });
    expect(metadataSearch).toHaveBeenCalled();

    const explicitProgram = new Command();
    registerSearchCommand(explicitProgram, source);
    output.mockClear();
    await explicitProgram.parseAsync([
      "node",
      "mcpget",
      "search",
      "notion.com",
      "--limit",
      "7",
      "--json",
    ]);
    const explicitPayload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
      data: { summary: Record<string, number>; candidates: unknown[] };
    };
    expect(explicitPayload.data.summary.returnedCandidates).toBe(7);
    expect(explicitPayload.data.summary.omittedCandidates).toBe(1);
    expect(explicitPayload.data.candidates).toHaveLength(7);

    const humanProgram = new Command();
    registerSearchCommand(humanProgram, source);
    output.mockClear();
    await humanProgram.parseAsync([
      "node",
      "mcpget",
      "search",
      "notion.com",
      "--limit",
      "2",
    ]);
    const humanOutput = output.mock.calls.flat().join("\n");
    expect(humanOutput).toContain("8 discovered · 8 matched · 2 returned");
    expect(humanOutput).toContain("6 omitted by limit");
    output.mockRestore();
  });

  it("keeps partial discovery distinct from candidates omitted by the response limit", async () => {
    const candidates = Array.from({ length: 8 }, (_, index) =>
      candidate(`io.github.vendor/notion-partial-${index}`, {
        title: `Notion Server ${index}`,
        description: "Search and update Notion pages and databases.",
      }),
    );
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerSearchCommand(program, {
      async searchByName() {
        return candidates;
      },
      async searchByNameWithMetadata() {
        return {
          candidates,
          status: "partial",
          terminationReason: "page_limit_reached",
          pagesFetched: 100,
          safetyLimitReached: true,
        };
      },
    });
    await program.parseAsync([
      "node",
      "mcpget",
      "search",
      "notion.com",
      "--json",
    ]);
    const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
      warnings: string[];
      data: {
        discovery: { status: string; pagesFetched: number };
        summary: Record<string, number>;
        candidates: unknown[];
      };
    };
    expect(payload.data.discovery).toMatchObject({
      status: "partial",
      pagesFetched: 100,
    });
    expect(payload.data.summary).toMatchObject({
      discoveredCandidates: 8,
      matchedCandidates: 8,
      returnedCandidates: 5,
      omittedCandidates: 3,
    });
    expect(payload.data.candidates).toHaveLength(5);
    expect(payload.warnings).toContain(
      "Registry discovery reached the 100-page safety limit. Showing the strongest matches found so far; additional candidates may exist.",
    );
    output.mockRestore();
  });

  it("returns an INVALID_INPUT envelope for an invalid candidate limit", async () => {
    const searchByName = vi.fn(async () => []);
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerSearchCommand(program, { searchByName });
    await program.parseAsync([
      "node",
      "mcpget",
      "search",
      "notion.com",
      "--limit",
      "0",
      "--json",
    ]);
    const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
      ok: boolean;
      error: { code: string };
    };
    expect(payload).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(process.exitCode).toBe(2);
    expect(searchByName).not.toHaveBeenCalled();
    output.mockRestore();
  });

  it("does not expose credential values, sensitive URLs, or configuration metadata in search output", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerSearchCommand(program, {
      async searchByName() {
        return [
          candidate("com.vendor/notion", {
            title: "Notion Remote",
            description: "Search Notion pages.",
            sourceRecordUrl:
              "https://registry.example/record?token=record-secret",
            operational: {
              deploymentModels: ["Remote endpoint"],
              transports: ["streamable-http"],
              packages: [],
              remoteEndpoints: [
                "https://user:password@remote.example/private/mcp?token=endpoint-secret",
              ],
              configurationInputs: [
                {
                  name: "NOTION_TOKEN",
                  required: true,
                  secret: true,
                  description: "credential-value-secret",
                  deployment: "remote-endpoint",
                },
              ],
              authentication: "Unknown",
              clientCompatibility: "Unknown",
              setupComplexity: "Unknown",
            },
          }),
        ];
      },
    });
    await program.parseAsync([
      "node",
      "mcpget",
      "search",
      "notion.com",
      "--json",
    ]);
    const json = output.mock.calls[0]?.[0] as string;
    for (const secret of [
      "password",
      "endpoint-secret",
      "record-secret",
      "credential-value-secret",
      "NOTION_TOKEN",
      "/private/mcp",
    ])
      expect(json).not.toContain(secret);
    expect(json).toContain("remote.example");
    expect(json).toContain("sensitive credential is declared");
    output.mockRestore();
  });

  it("returns structured JSON errors for invalid input", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    registerSearchCommand(program, {
      async searchByName() {
        return [];
      },
    });
    await program.parseAsync([
      "node",
      "mcpget",
      "search",
      "ftp://notion.com",
      "--json",
    ]);
    const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
      ok: boolean;
      command: string;
      error: { code: string };
    };
    expect(payload).toMatchObject({
      ok: false,
      command: "search",
      error: { code: "INVALID_INPUT" },
    });
    expect(errors).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
    output.mockRestore();
    errors.mockRestore();
  });

  it("surfaces sensitive configuration concerns in compact output without showing values", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerSearchCommand(program, {
      async searchByName() {
        return [
          candidate("author/notion-token", {
            title: "Notion Workspace MCP",
            description: "Search, read, and update Notion pages and databases.",
            operational: {
              deploymentModels: ["Local package"],
              transports: ["stdio"],
              packages: [],
              remoteEndpoints: [],
              configurationInputs: [
                {
                  name: "NOTION_TOKEN",
                  required: true,
                  secret: true,
                  description: "Requires a browser token_v2 cookie.",
                  deployment: "local-package",
                },
              ],
              authentication: "Unknown",
              clientCompatibility: "Unknown",
              setupComplexity: "Unknown",
            },
          }),
        ];
      },
    });
    await program.parseAsync(["node", "mcpget", "search", "notion"]);
    const rendered = output.mock.calls.flat().join("\n");
    expect(rendered).toContain("Elevated concern");
    expect(rendered).toContain("browser-session credential");
    expect(rendered).not.toContain("NOTION_TOKEN=secret");
    output.mockRestore();
  });

  it("sanitizes Registry names, descriptions, runtime hints, and security findings in terminal output", async () => {
    const malicious = candidate("com.vendor/notion", {
      title: "Readable\u001b]8;;https://evil.test\u0007Title",
      description: "Description\u001b[2J stays readable.",
      operational: {
        deploymentModels: ["Local package"],
        transports: ["stdio"],
        packages: [
          {
            registryType: "npm",
            identifier: "@vendor/server",
            runtimeHint: "node\u009d52;c;payload\u009c",
          },
        ],
        remoteEndpoints: [],
        configurationInputs: [
          {
            name: "API_KEY\u001b]8;;https://evil.test\u0007",
            secret: true,
            required: true,
            description: "Credential input\u001b[31m.",
            deployment: "local-package",
          },
        ],
        authentication: "Unknown",
        clientCompatibility: "Unknown",
        setupComplexity: "Unknown",
      },
    });
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerSearchCommand(program, {
      async searchByName() {
        return [malicious];
      },
    });
    await program.parseAsync(["node", "mcpget", "search", "notion", "--all"]);
    const rendered = output.mock.calls.flat().join("\n");
    expect(rendered).toContain("Readable");
    expect(rendered).toContain("Description");
    expect(containsTerminalControl(rendered)).toBe(false);
    output.mockRestore();
  });

  it("sanitizes Registry control characters in compact JSON output", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    registerSearchCommand(program, {
      async searchByName() {
        return [
          candidate("com.vendor/notion", {
            title: "Readable\u001b]52;c;payload\u0007",
            description: "Description\u001b[2J",
          }),
        ];
      },
    });
    await program.parseAsync(["node", "mcpget", "search", "notion", "--json"]);
    expect(output).toHaveBeenCalledOnce();
    const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
      schemaVersion: number;
      ok: boolean;
      command: string;
      data: {
        schemaVersion: number;
        candidates: Array<{ name: string; description: string }>;
      };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.data.schemaVersion).toBe(3);
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("search");
    expect(payload.data.candidates[0]?.name).toBe("Readable ]52;c;payload");
    expect(payload.data.candidates[0]?.description).toBe("Description [2J");
    expect(errors).not.toHaveBeenCalled();
    output.mockRestore();
    errors.mockRestore();
  });

  it("sanitizes Registry error messages in terminal and JSON modes", async () => {
    const message =
      "Registry failure\u001b]52;c;payload\u0007 remains readable.";
    const terminalProgram = new Command();
    const terminalErrors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    registerSearchCommand(terminalProgram, {
      async searchByName() {
        throw new Error(message);
      },
    });
    await terminalProgram.parseAsync([
      "node",
      "mcpget",
      "search",
      "notion.com",
    ]);
    const terminal = terminalErrors.mock.calls.flat().join("\n");
    expect(terminal).toContain("Registry failure");
    expect(containsTerminalControl(terminal)).toBe(false);
    process.exitCode = 0;
    terminalErrors.mockRestore();

    const jsonProgram = new Command();
    const jsonOutput = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const jsonErrors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    registerSearchCommand(jsonProgram, {
      async searchByName() {
        throw new Error(message);
      },
    });
    await jsonProgram.parseAsync([
      "node",
      "mcpget",
      "search",
      "notion.com",
      "--json",
    ]);
    const payload = JSON.parse(jsonOutput.mock.calls[0]?.[0] as string) as {
      schemaVersion: number;
      ok: boolean;
      command: string;
      error: { message: string };
    };
    expect(payload).toMatchObject({
      schemaVersion: 1,
      ok: false,
      command: "search",
    });
    expect(payload.error.message).toContain("Registry failure");
    expect(containsTerminalControl(payload.error.message)).toBe(false);
    expect(jsonErrors).not.toHaveBeenCalled();
    process.exitCode = 0;
    jsonOutput.mockRestore();
    jsonErrors.mockRestore();
  });

  it("handles invalid input, no results, and Registry failures", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    registerSearchCommand(program, {
      async searchByName() {
        return [];
      },
    });
    await program.parseAsync(["node", "mcpget", "search", "ftp://notion.com"]);
    expect(errors.mock.calls.flat().join(" ")).toContain("Only http and https");
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
    errors.mockClear();
    await program.parseAsync(["node", "mcpget", "search", "notion.com"]);
    expect(output.mock.calls.flat().join("\n")).toContain(
      "No candidates were returned",
    );

    const failedProgram = new Command();
    registerSearchCommand(failedProgram, {
      async searchByName() {
        throw new Error("offline");
      },
    });
    await failedProgram.parseAsync(["node", "mcpget", "search", "notion.com"]);
    expect(errors.mock.calls.flat().join(" ")).toContain("offline");
    process.exitCode = 0;
    output.mockRestore();
    errors.mockRestore();
  });
});

describe("inspect command", () => {
  it("retains detailed evidence, descriptions, and operational requirements in JSON", async () => {
    const inspection = candidate("com.notion/mcp", {
      title: "Notion MCP",
      description:
        "Search, read, create, update, and delete Notion pages and databases. ".repeat(
          5,
        ),
      version: "2.0.0",
      registryStatus: "active",
      updatedAt: "2026-01-01T00:00:00Z",
      websiteUrl: "https://notion.com/mcp?api_key=website-secret",
      sourceRecordUrl: "https://registry.example/record?token=registry-secret",
      operational: {
        deploymentModels: ["Local package"],
        transports: ["stdio"],
        packages: [
          {
            registryType: "npm",
            identifier: "@example/notion-mcp",
            version: "2.0.0",
          },
        ],
        remoteEndpoints: [
          "https://user:password@mcp.notion.com/mcp?token=endpoint-secret",
        ],
        configurationInputs: [
          {
            name: "NOTION_TOKEN",
            required: true,
            secret: true,
            description: "Notion integration token.",
            deployment: "local-package",
          },
        ],
        authentication: "Unknown",
        clientCompatibility: "Unknown",
        setupComplexity: "Unknown",
      },
    });
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerInspectCommand(program, {
      async getByIdentifier() {
        return inspection;
      },
      async searchByName() {
        return [inspection];
      },
    });
    await program.parseAsync([
      "node",
      "mcpget",
      "inspect",
      "com.notion/mcp",
      "--for",
      "notion.com",
      "--json",
    ]);
    const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
      data: {
        server: {
          description: string;
          websiteUrl: string;
          sourceRecordUrl: string;
        };
        evaluation: {
          capabilities: Array<{ name: string; basis: string }>;
          evidence: unknown[];
          securityFindings: string[];
          maintenanceSignals: string[];
          recommendation: { state: string; status: string };
        };
        operational: {
          configurationInputs: Array<{ name: string; secret?: boolean }>;
          packages: Array<{ identifier?: string }>;
          remoteEndpoints: string[];
        };
      };
    };
    expect(payload.data.server.description).toBe(inspection.description);
    expect(payload.data.evaluation.evidence.length).toBeGreaterThan(0);
    expect(payload.data.evaluation.capabilities).toEqual(
      expect.arrayContaining([expect.objectContaining({ basis: "inferred" })]),
    );
    expect(payload.data.evaluation.maintenanceSignals.length).toBeGreaterThan(
      0,
    );
    expect(payload.data.evaluation.securityFindings.length).toBeGreaterThan(0);
    expect(payload.data.evaluation.recommendation).toMatchObject({
      state: "recommended",
      status: "Recommended for consideration; not independently verified",
    });
    expect(payload.data.operational.configurationInputs).toContainEqual(
      expect.objectContaining({ name: "NOTION_TOKEN", secret: true }),
    );
    expect(payload.data.operational.packages).toContainEqual(
      expect.objectContaining({ identifier: "@example/notion-mcp" }),
    );
    const serialized = JSON.stringify(payload);
    for (const secret of [
      "website-secret",
      "registry-secret",
      "endpoint-secret",
      "password",
    ])
      expect(serialized).not.toContain(secret);
    expect(payload.data.operational.remoteEndpoints[0]).toContain(
      "token=REDACTED",
    );
    output.mockRestore();
  });

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
    await program.parseAsync([
      "node",
      "mcpget",
      "inspect",
      "com.notion/mcp",
      "--for",
      "notion.com",
    ]);
    const rendered = output.mock.calls.flat().join("\n");
    expect(rendered).toContain("Registry identifier: com.notion/mcp");
    expect(rendered).toContain("Relevance: Direct integration");
    expect(rendered).toContain("Match confidence: High");
    expect(rendered).toContain("Authentication: Unknown");
    output.mockRestore();
  });

  it("emits a single valid JSON envelope and does not contaminate stdout", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    registerInspectCommand(program, {
      async getByIdentifier() {
        return candidate("com.notion/mcp", {
          title: "Notion MCP",
          description: "Search and update Notion pages.",
        });
      },
    });
    await program.parseAsync([
      "node",
      "mcpget",
      "inspect",
      "com.notion/mcp",
      "--json",
    ]);
    expect(output).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
      ok: boolean;
      command: string;
      data: {
        server: { registryIdentifier: string };
        installedRecords: unknown[];
      };
    };
    expect(payload).toMatchObject({ ok: true, command: "inspect" });
    expect(payload.data.server.registryIdentifier).toBe("com.notion/mcp");
    expect(payload.data.installedRecords).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    expect(JSON.stringify(payload)).not.toContain("[object Object]");
    output.mockRestore();
    errors.mockRestore();
  });

  it("returns a structured JSON failure with a stable invalid-input code", async () => {
    const program = new Command();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    registerInspectCommand(program, {
      async getByIdentifier() {
        throw new Error("registry unavailable");
      },
    });
    await program.parseAsync(["node", "mcpget", "inspect", "bad/id", "--json"]);
    const payload = JSON.parse(output.mock.calls[0]?.[0] as string) as {
      ok: boolean;
      command: string;
      error: { code: string; message: string };
    };
    expect(payload).toMatchObject({
      ok: false,
      command: "inspect",
      error: { code: "OPERATIONAL_FAILURE", message: "registry unavailable" },
    });
    expect(errors).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    output.mockRestore();
    errors.mockRestore();
  });
});

describe("CLI parser errors", () => {
  const cli = join(process.cwd(), "dist", "cli", "index.js");

  function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
    return spawnSync(process.execPath, [cli, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });
  }

  it("uses exit 2 for missing required arguments", () => {
    const result = run(["search"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("missing required argument");
  });

  it("uses exit 2 for unknown commands and unknown options", () => {
    const unknownCommand = run(["unknown"]);
    expect(unknownCommand.status).toBe(2);
    expect(unknownCommand.stderr).toContain("unknown command");

    const unknownOption = run(["search", "notion", "--unknown"]);
    expect(unknownOption.status).toBe(2);
    expect(unknownOption.stderr).toContain("unknown option");
  });

  it("uses exit 2 for missing option values", () => {
    const result = run(["inspect", "server", "--for"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("option '--for <url>' argument missing");
  });

  it("preserves help and version success behavior", () => {
    expect(run(["--help"]).status).toBe(0);
    expect(run(["--help"]).stdout).toContain("Usage:");
    expect(run(["--version"]).status).toBe(0);
    expect(run(["--version"]).stdout.trim()).toBe(packageVersion);
  });

  it("returns a JSON invalid-input envelope when --json is present", () => {
    const result = run(["search", "--json"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      schemaVersion: number;
      ok: boolean;
      command: string;
      error: { code: string };
      warnings: string[];
    };
    expect(payload).toMatchObject({
      schemaVersion: 1,
      ok: false,
      command: "search",
      error: { code: "INVALID_INPUT" },
      warnings: [],
    });
  });

  it.each([
    ["install", ["install", "--json"]],
    ["remove", ["remove", "--json"]],
  ])(
    "returns a structured JSON parser error for malformed %s arguments",
    (command, args) => {
      const result = run(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout) as {
        schemaVersion: number;
        ok: boolean;
        command: string;
        error: { code: string };
        warnings: string[];
      };
      expect(payload).toMatchObject({
        schemaVersion: 1,
        ok: false,
        command,
        error: { code: "INVALID_INPUT" },
        warnings: [],
      });
    },
  );

  it("uses stderr for parser JSON mode that is not determined safely", () => {
    const result = run(["unknown", "--json"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown command");
  });

  it("returns JSON approval failures for built install and remove commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcpget-built-cli-"));
    const codexHome = join(directory, ".codex");
    try {
      const install = run(
        ["install", "npm:@example/server", "codex", "--json"],
        { ...process.env, CODEX_HOME: codexHome },
      );
      expect(install.status).toBe(4);
      expect(install.stderr).toBe("");
      const installPayload = JSON.parse(install.stdout) as {
        schemaVersion: number;
        ok: boolean;
        command: string;
        error: { code: string };
      };
      expect(installPayload).toMatchObject({
        schemaVersion: 1,
        ok: false,
        command: "install",
        error: { code: "MISSING_REQUIRED_INPUT" },
      });

      await mkdir(codexHome, { recursive: true });
      const configPath = join(codexHome, "config.toml");
      await writeFile(
        configPath,
        '[mcp_servers.sample]\ncommand = "node"\nargs = ["server.js"]\n',
      );
      const remove = run(["remove", "sample", "codex", "--json"], {
        ...process.env,
        CODEX_HOME: codexHome,
      });
      expect(remove.status).toBe(4);
      expect(remove.stderr).toBe("");
      const removePayload = JSON.parse(remove.stdout) as {
        schemaVersion: number;
        ok: boolean;
        command: string;
        error: { code: string };
      };
      expect(removePayload).toMatchObject({
        schemaVersion: 1,
        ok: false,
        command: "remove",
        error: { code: "MISSING_REQUIRED_INPUT" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
