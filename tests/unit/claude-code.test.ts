import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../src/installers/claude-code-adapter.js";
import { resolveClaudeCodeScopeContext } from "../../src/installers/claude-code-scopes.js";
import { detectExistingServerMatches } from "../../src/installers/existing-server-detection.js";
import { collectInheritedRequiredCredentials } from "../../src/cli/credentials.js";

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

describe("Claude Code MCP scopes", () => {
  it("writes user scope at the top level of ~/.claude.json and preserves unrelated state", async () => {
    const root = await temporaryDirectory("mcpget-claude-code-user-");
    const claudeJson = path.join(root, ".claude.json");
    await writeFile(
      claudeJson,
      JSON.stringify({
        theme: "keep",
        mcpServers: {
          existing: { type: "stdio", command: "node", args: ["keep.js"] },
        },
        projects: { "C:\\old": { allowedTools: [] } },
      }),
    );
    const adapter = new ClaudeCodeAdapter(claudeJson, "user");
    await adapter.add({
      name: "notion",
      command: "node",
      args: ["server.js"],
      env: { EXISTING: "keep", NOTION_TOKEN: "secret" },
      type: "stdio",
    });
    const written = JSON.parse(await readFile(claudeJson, "utf8")) as {
      theme: string;
      projects: Record<string, unknown>;
      mcpServers: Record<string, unknown>;
    };
    expect(written.theme).toBe("keep");
    expect(written.projects).toHaveProperty("C:\\old");
    expect(written.mcpServers.existing).toEqual({
      type: "stdio",
      command: "node",
      args: ["keep.js"],
    });
    expect(written.mcpServers.notion).toMatchObject({
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { EXISTING: "keep", NOTION_TOKEN: "secret" },
    });
  });

  it("writes local scope under the project path and preserves unrelated project state", async () => {
    const root = await temporaryDirectory("mcpget-claude-code-local-");
    const projectRoot = path.join(root, "project");
    await mkdir(projectRoot);
    await mkdir(path.join(projectRoot, ".git"));
    const claudeJson = path.join(root, ".claude.json");
    await writeFile(
      claudeJson,
      JSON.stringify({
        account: "keep",
        projects: {
          [projectRoot]: {
            allowedTools: ["Bash(npm test *)"],
            mcpServers: {
              existing: { type: "stdio", command: "node", args: ["keep.js"] },
            },
          },
        },
      }),
    );
    const adapter = new ClaudeCodeAdapter(claudeJson, "local", projectRoot);
    await adapter.add({
      name: "notion",
      command: "node",
      args: ["server.js"],
      env: { NOTION_TOKENS_DIR: "C:\\tokens" },
    });
    const written = JSON.parse(await readFile(claudeJson, "utf8")) as {
      account: string;
      projects: Record<
        string,
        { allowedTools: string[]; mcpServers: Record<string, unknown> }
      >;
    };
    expect(written.account).toBe("keep");
    expect(written.projects[projectRoot]?.allowedTools).toEqual([
      "Bash(npm test *)",
    ]);
    expect(written.projects[projectRoot]?.mcpServers.existing).toBeDefined();
    expect(written.projects[projectRoot]?.mcpServers.notion).toMatchObject({
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { NOTION_TOKENS_DIR: "C:\\tokens" },
    });
  });

  it("writes project scope to .mcp.json and blocks untrusted projects", async () => {
    const root = await temporaryDirectory("mcpget-claude-code-project-");
    const projectRoot = path.join(root, "project");
    await mkdir(projectRoot);
    await mkdir(path.join(projectRoot, ".git"));
    const claudeJson = path.join(root, ".claude.json");
    await writeFile(
      claudeJson,
      JSON.stringify({
        projects: {
          [projectRoot]: { hasTrustDialogAccepted: false },
        },
      }),
    );
    const untrusted = new ClaudeCodeAdapter(claudeJson, "project", projectRoot);
    await expect(
      untrusted.add({
        name: "notion",
        command: "node",
        args: ["server.js"],
      }),
    ).rejects.toThrow(/project trust/i);
    await expect(
      readFile(path.join(projectRoot, ".mcp.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(
      claudeJson,
      JSON.stringify({
        projects: {
          [projectRoot]: {
            hasTrustDialogAccepted: true,
            enabledMcpjsonServers: ["existing"],
          },
        },
      }),
    );
    await writeFile(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          existing: { type: "stdio", command: "node", args: ["keep.js"] },
        },
      }),
    );
    const trusted = new ClaudeCodeAdapter(claudeJson, "project", projectRoot);
    await trusted.add({
      name: "notion",
      url: "https://example.test/mcp",
      transport: "http",
    });
    const written = JSON.parse(
      await readFile(path.join(projectRoot, ".mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers.existing).toBeDefined();
    expect(written.mcpServers.notion).toMatchObject({
      type: "http",
      url: "https://example.test/mcp",
    });
  });

  it("detects confirmed and conflicting registrations across Claude Code scopes", async () => {
    const root = await temporaryDirectory("mcpget-claude-code-duplicates-");
    const claudeJson = path.join(root, ".claude.json");
    await writeFile(
      claudeJson,
      JSON.stringify({
        mcpServers: {
          notion: { type: "stdio", command: "node", args: ["server.js"] },
        },
      }),
    );
    const adapter = new ClaudeCodeAdapter(claudeJson, "user");
    const registrations = await adapter.readRegistrations();
    const matches = detectExistingServerMatches(
      "com.foreverworks/notion",
      {
        name: "notion",
        command: "node",
        args: ["server.js"],
      },
      "@foreverworks/mcp-notion",
      registrations,
      [],
    );
    expect(
      matches.some((match) => match.classification === "confirmed_duplicate"),
    ).toBe(true);
  });

  it("uses inherited credentials only for declared required inputs and distinguishes directory paths", async () => {
    const inherited = collectInheritedRequiredCredentials(
      [
        {
          name: "NOTION_TOKENS_DIR",
          required: true,
          secret: true,
          description: "A folder holding one token file per workspace",
          deployment: "local-package",
        },
        {
          name: "NOTION_TOKEN",
          required: true,
          secret: true,
          deployment: "local-package",
        },
      ],
      {
        NOTION_TOKENS_DIR: "C:\\tokens",
        NOTION_TOKEN: "secret-value",
        UNDECLARED: "do-not-read",
      },
      {},
    );
    expect(inherited.suppliedNames).toEqual([
      "NOTION_TOKENS_DIR",
      "NOTION_TOKEN",
    ]);
    expect(inherited.kinds.NOTION_TOKENS_DIR).toBe("directory_path");
    expect(inherited.kinds.NOTION_TOKEN).toBe("secret");
  });

  it("removes only the selected scope and preserves external edits", async () => {
    const root = await temporaryDirectory("mcpget-claude-code-remove-");
    const claudeJson = path.join(root, ".claude.json");
    await writeFile(
      claudeJson,
      JSON.stringify({
        account: "keep",
        mcpServers: {
          notion: { type: "stdio", command: "node", args: ["server.js"] },
          other: { type: "stdio", command: "node", args: ["other.js"] },
        },
      }),
    );
    await writeFile(
      claudeJson,
      JSON.stringify({
        account: "externally-edited",
        mcpServers: {
          notion: { type: "stdio", command: "node", args: ["server.js"] },
          other: { type: "stdio", command: "node", args: ["other.js"] },
          external: { type: "stdio", command: "node", args: ["external.js"] },
        },
      }),
    );
    const adapter = new ClaudeCodeAdapter(claudeJson, "user");
    await adapter.remove("notion");
    const written = JSON.parse(await readFile(claudeJson, "utf8")) as {
      account: string;
      mcpServers: Record<string, unknown>;
    };
    expect(written.account).toBe("externally-edited");
    expect(written.mcpServers).not.toHaveProperty("notion");
    expect(written.mcpServers).toHaveProperty("other");
    expect(written.mcpServers).toHaveProperty("external");
  });

  it("resolves official Claude Code local and project scope paths", async () => {
    const root = await temporaryDirectory("mcpget-claude-code-context-");
    const projectRoot = path.join(root, "project");
    await mkdir(projectRoot);
    await mkdir(path.join(projectRoot, ".git"));
    const claudeJson = path.join(root, ".claude.json");
    await writeFile(
      claudeJson,
      JSON.stringify({
        projects: {
          [projectRoot]: { hasTrustDialogAccepted: true },
        },
      }),
    );
    const context = await resolveClaudeCodeScopeContext({
      cwd: projectRoot,
      claudeJsonPath: claudeJson,
    });
    expect(context.projectStatus).toBe("trusted");
    expect(context.targets.map((target) => target.scope)).toEqual([
      "user",
      "local",
      "project",
    ]);
    expect(
      context.targets.find((target) => target.scope === "project")?.configPath,
    ).toBe(path.join(projectRoot, ".mcp.json"));
  });
});
