import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonClientAdapter } from "../../src/installers/json-client-adapter.js";
import { resolveCopilotConfigPath } from "../../src/installers/adapters.js";
import { detectExistingServerMatches } from "../../src/installers/existing-server-detection.js";
import { resolveCopilotScopeContext } from "../../src/installers/copilot-scopes.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Copilot user configuration", () => {
  it("uses COPILOT_HOME or ~/.copilot for the shared native file", () => {
    expect(
      resolveCopilotConfigPath({
        home: "C:\\Users\\test",
        copilotHome: "C:\\CopilotHome",
        platform: "win32",
      }),
    ).toBe("C:\\CopilotHome\\mcp-config.json");
    expect(
      resolveCopilotConfigPath({
        home: "C:\\Users\\test",
        platform: "win32",
      }),
    ).toBe("C:\\Users\\test\\.copilot\\mcp-config.json");
    expect(
      resolveCopilotConfigPath({
        home: "/home/test",
        copilotHome: "/srv/copilot",
        platform: "linux",
      }),
    ).toBe("/srv/copilot/mcp-config.json");
    expect(
      resolveCopilotConfigPath({
        home: "/home/test",
        platform: "linux",
      }),
    ).toBe("/home/test/.copilot/mcp-config.json");
  });

  it.each(["copilot-vscode", "copilot-cli"] as const)(
    "writes portable mcpServers entries for %s and preserves unrelated state",
    async (client) => {
      const root = await mkdtemp(path.join(tmpdir(), "mcpget-copilot-"));
      roots.push(root);
      const configPath = path.join(root, "mcp-config.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          account: "preserve",
          mcpServers: {
            existing: {
              type: "stdio",
              command: "node",
              args: ["keep.js"],
              env: { EXISTING: "keep" },
              tools: ["*"],
            },
          },
        }),
      );
      const adapter = new JsonClientAdapter(
        client,
        client === "copilot-vscode"
          ? "GitHub Copilot in VS Code"
          : "GitHub Copilot CLI",
        configPath,
      );
      await adapter.add({
        name: "notion",
        command: "node",
        args: ["server.js"],
        env: { NOTION_TOKENS_DIR: "C:\\tokens" },
        type: "stdio",
      });
      const written = JSON.parse(await readFile(configPath, "utf8")) as {
        account: string;
        mcpServers: Record<string, unknown>;
      };
      expect(written.account).toBe("preserve");
      expect(written.mcpServers.existing).toEqual({
        type: "stdio",
        command: "node",
        args: ["keep.js"],
        env: { EXISTING: "keep" },
        tools: ["*"],
      });
      expect(written.mcpServers.notion).toMatchObject({
        type: "stdio",
        command: "node",
        args: ["server.js"],
        env: { NOTION_TOKENS_DIR: "C:\\tokens" },
      });
      await expect(
        adapter.verify({
          name: "notion",
          command: "node",
          args: ["server.js"],
          env: { NOTION_TOKENS_DIR: "C:\\tokens" },
          type: "stdio",
        }),
      ).resolves.toMatchObject({ verified: true });
    },
  );

  it("treats VS Code and CLI shares as one duplicate target", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "mcpget-copilot-duplicate-"),
    );
    roots.push(root);
    const configPath = path.join(root, "mcp-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          notion: {
            type: "http",
            url: "https://mcp.notion.com/mcp",
            tools: ["*"],
          },
        },
      }),
    );
    const vscode = new JsonClientAdapter(
      "copilot-vscode",
      "GitHub Copilot in VS Code",
      configPath,
    );
    const cli = new JsonClientAdapter(
      "copilot-cli",
      "GitHub Copilot CLI",
      configPath,
    );
    const registrations = [
      ...(await vscode.readRegistrations()),
      ...(await cli.readRegistrations()),
    ];
    const deduplicated = registrations.filter(
      (registration, index) =>
        registrations.findIndex(
          (candidate) =>
            candidate.configPath === registration.configPath &&
            candidate.name === registration.name,
        ) === index,
    );
    const matches = detectExistingServerMatches(
      "com.notion/mcp",
      {
        name: "notion",
        url: "https://mcp.notion.com/mcp",
        transport: "http",
        type: "http",
      },
      undefined,
      deduplicated,
      [],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.classification).toBe("confirmed_duplicate");
  });

  it("removes only the selected entry and preserves unrelated Copilot configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mcpget-copilot-remove-"));
    roots.push(root);
    const configPath = path.join(root, "mcp-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        account: "preserve",
        mcpServers: {
          notion: { type: "http", url: "https://mcp.notion.com/mcp" },
          other: { type: "stdio", command: "node", args: ["other.js"] },
        },
      }),
    );
    const adapter = new JsonClientAdapter(
      "copilot-cli",
      "GitHub Copilot CLI",
      configPath,
    );
    await adapter.remove("notion");
    const written = JSON.parse(await readFile(configPath, "utf8")) as {
      account: string;
      mcpServers: Record<string, unknown>;
    };
    expect(written.account).toBe("preserve");
    expect(written.mcpServers).not.toHaveProperty("notion");
    expect(written.mcpServers).toHaveProperty("other");
  });

  it("writes VS Code project .mcp.json with top-level mcpServers", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "mcpget-copilot-vscode-project-"),
    );
    roots.push(root);
    await mkdir(path.join(root, ".git"));
    const configPath = path.join(root, ".mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          existing: { type: "stdio", command: "node", args: ["keep.js"] },
        },
        otherSetting: "preserve",
      }),
    );
    const adapter = new JsonClientAdapter(
      "copilot-vscode",
      "GitHub Copilot in VS Code",
      configPath,
      undefined,
      "project",
      "mcpServers",
    );
    await adapter.add({
      name: "notion",
      url: "https://mcp.notion.com/mcp",
      transport: "http",
      type: "http",
    });
    const written = JSON.parse(await readFile(configPath, "utf8")) as {
      otherSetting: string;
      mcpServers: Record<string, unknown>;
    };
    expect(written.otherSetting).toBe("preserve");
    expect(written.mcpServers.existing).toBeDefined();
    expect(written.mcpServers.notion).toMatchObject({
      type: "http",
      url: "https://mcp.notion.com/mcp",
    });
  });

  it.each([
    [
      "mcpServers",
      JSON.stringify({
        mcpServers: {
          existing: { type: "stdio", command: "node", args: ["keep.js"] },
        },
        otherSetting: "preserve",
      }),
    ],
    [
      "bare",
      JSON.stringify({
        existing: { type: "stdio", command: "node", args: ["keep.js"] },
        otherSetting: "preserve",
      }),
    ],
  ] as const)(
    "writes Copilot CLI project %s format and preserves unrelated state",
    async (_format, contents) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "mcpget-copilot-cli-project-"),
      );
      roots.push(root);
      const configPath = path.join(root, ".mcp.json");
      await writeFile(configPath, contents);
      const adapter = new JsonClientAdapter(
        "copilot-cli",
        "GitHub Copilot CLI",
        configPath,
        undefined,
        "project",
        _format,
      );
      await adapter.add({
        name: "notion",
        url: "https://mcp.notion.com/mcp",
        transport: "http",
        type: "http",
      });
      const written = JSON.parse(await readFile(configPath, "utf8")) as {
        otherSetting: string;
        mcpServers?: Record<string, unknown>;
      };
      expect(written.otherSetting).toBe("preserve");
      if (_format === "mcpServers")
        expect(written.mcpServers?.notion).toMatchObject({
          type: "http",
          url: "https://mcp.notion.com/mcp",
        });
      else {
        const bare = written as unknown as Record<string, unknown>;
        expect((bare.notion as Record<string, unknown>).url).toBe(
          "https://mcp.notion.com/mcp",
        );
      }
    },
  );

  it("discovers VS Code and CLI project targets with native paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mcpget-copilot-context-"));
    roots.push(root);
    await mkdir(path.join(root, ".git"));
    await mkdir(path.join(root, ".github"));
    const homeConfig = path.join(root, ".copilot", "mcp-config.json");
    const context = await resolveCopilotScopeContext({
      cwd: root,
      userConfigPath: homeConfig,
    });
    expect(context.projectRoot).toBe(root);
    expect(
      context.targets
        .filter((target) => target.scope === "project")
        .map((target) => `${target.id}:${target.configPath}`),
    ).toEqual([
      `copilot-vscode:${path.join(root, ".mcp.json")}`,
      `copilot-cli:${path.join(root, ".mcp.json")}`,
      `copilot-cli:${path.join(root, ".github", "mcp.json")}`,
    ]);
  });

  it("sees project entries as separate targets from the shared user file", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "mcpget-copilot-precedence-"),
    );
    roots.push(root);
    const userPath = path.join(root, "mcp-config.json");
    const projectPath = path.join(root, ".mcp.json");
    await writeFile(
      userPath,
      JSON.stringify({
        mcpServers: {
          notion: { type: "http", url: "https://mcp.notion.com/mcp" },
        },
      }),
    );
    await writeFile(
      projectPath,
      JSON.stringify({
        mcpServers: {
          notion: { type: "http", url: "https://project.example/mcp" },
        },
      }),
    );
    const user = new JsonClientAdapter(
      "copilot-vscode",
      "GitHub Copilot in VS Code",
      userPath,
    );
    const project = new JsonClientAdapter(
      "copilot-vscode",
      "GitHub Copilot in VS Code",
      projectPath,
      undefined,
      "project",
      "mcpServers",
    );
    const matches = detectExistingServerMatches(
      "com.notion/mcp",
      {
        name: "notion",
        url: "https://project.example/mcp",
        transport: "http",
        type: "http",
      },
      undefined,
      [
        ...(await user.readRegistrations()),
        ...(await project.readRegistrations()),
      ],
      [],
    );
    expect(
      matches.some((match) => match.classification === "name_conflict"),
    ).toBe(true);
  });
});
