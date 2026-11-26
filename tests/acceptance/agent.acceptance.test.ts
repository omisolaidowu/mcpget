import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(process.cwd());
const cli = join(root, "dist", "cli", "index.js");
const preload = pathToFileURL(
  join(root, "tests", "fixtures", "acceptance-fetch.mjs"),
).href;
const tempRoots: string[] = [];

beforeAll(() => {
  tempRoots.length = 0;
});

afterAll(async () => {
  await Promise.all(
    tempRoots.map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function isolatedEnvironment(mode = "primary") {
  const home = await mkdtemp(join(tmpdir(), "mcpget-agent-home-"));
  const codexHome = join(home, ".codex");
  await mkdir(codexHome, { recursive: true });
  tempRoots.push(home);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    CODEX_HOME: codexHome,
    MCPGET_CLAUDE_CONFIG_PATH: join(
      home,
      ".config",
      "Claude",
      "claude_desktop_config.json",
    ),
    MCPGET_DATA_DIR: join(home, ".mcpget-data"),
    MCPGET_ACCEPTANCE_MODE: mode,
    NODE_OPTIONS:
      `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`.trim(),
  };
  return { home, codexHome, env };
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd = root) {
  return spawnSync(process.execPath, ["--import", preload, cli, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function parseJson(result: ReturnType<typeof run>) {
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.stdout.trim()).not.toBe("");
  return JSON.parse(result.stdout);
}

function expectEnvelope(
  payload: {
    schemaVersion: number;
    ok: boolean;
    command: string;
    warnings: unknown[];
    data?: unknown;
    error?: { code: string; message: string };
  },
  command: string,
  ok: boolean,
) {
  expect(payload.schemaVersion).toBe(1);
  expect(payload.ok).toBe(ok);
  expect(payload.command).toBe(command);
  expect(Array.isArray(payload.warnings)).toBe(true);
  if (ok) expect(payload).toHaveProperty("data");
  else {
    expect(payload.error?.code).toBeTypeOf("string");
    expect(payload.error?.message).toBeTypeOf("string");
  }
  expect(JSON.stringify(payload)).not.toContain("ACCEPTANCE_SECRET");
  expect(JSON.stringify(payload)).not.toContain("secret-token");
}

describe("MCPGet built CLI agent workflow", () => {
  it("installs Copilot project scope without changing user or unrelated project state", async () => {
    const isolated = await isolatedEnvironment("primary");
    const project = join(isolated.home, "workspace");
    await mkdir(join(project, ".git"), { recursive: true });
    await writeFile(
      join(project, ".mcp.json"),
      JSON.stringify({
        account: "preserve",
        mcpServers: {
          existing: { type: "stdio", command: "node", args: ["keep.js"] },
        },
      }),
    );
    isolated.env.MCPGET_COPILOT_CONFIG_PATH = join(
      isolated.home,
      ".copilot",
      "mcp-config.json",
    );
    await mkdir(join(isolated.home, ".copilot"), { recursive: true });
    await writeFile(
      isolated.env.MCPGET_COPILOT_CONFIG_PATH,
      JSON.stringify({
        account: "keep-user",
        mcpServers: {
          existing: { type: "stdio", command: "node", args: ["keep.js"] },
        },
      }),
    );

    const install = run(
      [
        "install",
        "com.notion/acceptance-test",
        "copilot-vscode",
        "--scope",
        "project",
        "--candidate",
        "com.notion/acceptance-test",
        "--source",
        "remote",
        "--yes",
        "--json",
      ],
      { ...isolated.env, PWD: project },
      project,
    );
    expect(install.status).toBe(0);
    const payload = parseJson(install);
    expectEnvelope(payload, "install", true);
    expect(payload.data.configuration).toMatchObject({
      scope: "project",
      status: "completed",
    });

    const projectConfig = JSON.parse(
      await readFile(join(project, ".mcp.json"), "utf8"),
    ) as { account: string; mcpServers: Record<string, unknown> };
    expect(projectConfig.account).toBe("preserve");
    expect(projectConfig.mcpServers.existing).toBeDefined();
    expect(
      projectConfig.mcpServers["notion-acceptance-test-mcp"],
    ).toMatchObject({
      type: "http",
      url: "https://93.184.216.34/mcp",
    });

    const userConfig = JSON.parse(
      await readFile(isolated.env.MCPGET_COPILOT_CONFIG_PATH, "utf8"),
    ) as { account: string; mcpServers: Record<string, unknown> };
    expect(userConfig.account).toBe("keep-user");
    expect(userConfig.mcpServers).not.toHaveProperty(
      "notion-acceptance-test-mcp",
    );

    const list = run(
      ["list", "copilot-vscode", "--scope", "project", "--json"],
      { ...isolated.env, PWD: project },
      project,
    );
    expect(list.status).toBe(0);
    const listPayload = parseJson(list);
    expectEnvelope(listPayload, "list", true);
    expect(listPayload.data.count).toBe(2);

    const inspect = run(
      ["inspect", "com.notion/acceptance-test", "--for", "notion", "--json"],
      { ...isolated.env, PWD: project },
      project,
    );
    expect(inspect.status).toBe(0);
    const inspectPayload = parseJson(inspect);
    expectEnvelope(inspectPayload, "inspect", true);
    expect(inspectPayload.data.installedRecords.length).toBeGreaterThan(0);

    const doctor = run(
      ["doctor", "copilot-vscode", "--scope", "project", "--json"],
      { ...isolated.env, PWD: project },
      project,
    );
    expect(doctor.status).toBe(0);
    const doctorPayload = parseJson(doctor);
    expectEnvelope(doctorPayload, "doctor", true);

    const remove = run(
      [
        "remove",
        "notion-acceptance-test-mcp",
        "copilot-vscode",
        "--scope",
        "project",
        "--yes",
        "--json",
      ],
      { ...isolated.env, PWD: project },
      project,
    );
    expect(remove.status).toBe(0);
    const remaining = JSON.parse(
      await readFile(join(project, ".mcp.json"), "utf8"),
    ) as { account: string; mcpServers: Record<string, unknown> };
    expect(remaining.account).toBe("preserve");
    expect(remaining.mcpServers.existing).toBeDefined();
  });

  it("installs and deduplicates Copilot VS Code and CLI through their shared user file", async () => {
    const isolated = await isolatedEnvironment("primary");
    const copilotHome = join(isolated.home, ".copilot");
    await mkdir(copilotHome, { recursive: true });
    isolated.env.MCPGET_COPILOT_CONFIG_PATH = join(
      copilotHome,
      "mcp-config.json",
    );
    await writeFile(
      isolated.env.MCPGET_COPILOT_CONFIG_PATH,
      JSON.stringify({
        account: "preserve",
        mcpServers: {
          existing: {
            type: "stdio",
            command: "node",
            args: ["keep.js"],
          },
        },
      }),
    );

    for (const client of ["copilot-vscode", "copilot-cli"]) {
      const install = run(
        [
          "install",
          "com.notion/acceptance-test",
          client,
          "--candidate",
          "com.notion/acceptance-test",
          "--source",
          "remote",
          "--yes",
          "--json",
        ],
        isolated.env,
      );
      if (client === "copilot-vscode") {
        expect(install.status).toBe(0);
        const payload = parseJson(install);
        expectEnvelope(payload, "install", true);
        expect(payload.data.configuration.status).toBe("completed");
      } else {
        expect(install.status).toBe(0);
        const payload = parseJson(install);
        expectEnvelope(payload, "install", true);
        expect(payload.data.alreadyConfigured).toBe(true);
      }
    }

    const written = JSON.parse(
      await readFile(isolated.env.MCPGET_COPILOT_CONFIG_PATH, "utf8"),
    ) as {
      account: string;
      mcpServers: Record<string, unknown>;
    };
    expect(written.account).toBe("preserve");
    expect(written.mcpServers.existing).toBeDefined();
    expect(written.mcpServers["notion-acceptance-test-mcp"]).toMatchObject({
      type: "http",
      url: "https://93.184.216.34/mcp",
    });

    const inspect = run(
      ["inspect", "com.notion/acceptance-test", "--for", "notion", "--json"],
      isolated.env,
    );
    expect(inspect.status).toBe(0);
    const inspectPayload = parseJson(inspect);
    expectEnvelope(inspectPayload, "inspect", true);
    expect(inspectPayload.data.server.registryIdentifier).toBe(
      "com.notion/acceptance-test",
    );

    const list = run(["list", "copilot-vscode", "--json"], isolated.env);
    expect(list.status).toBe(0);
    const listPayload = parseJson(list);
    expectEnvelope(listPayload, "list", true);
    expect(listPayload.data.count).toBe(2);

    const doctor = run(["doctor", "copilot-cli", "--json"], isolated.env);
    expect(doctor.status).toBe(0);
    const doctorPayload = parseJson(doctor);
    expectEnvelope(doctorPayload, "doctor", true);

    const remove = run(
      [
        "remove",
        "notion-acceptance-test-mcp",
        "copilot-cli",
        "--yes",
        "--json",
      ],
      isolated.env,
    );
    expect(remove.status).toBe(0);
    const removePayload = parseJson(remove);
    expectEnvelope(removePayload, "remove", true);

    const remaining = JSON.parse(
      await readFile(isolated.env.MCPGET_COPILOT_CONFIG_PATH, "utf8"),
    ) as { account: string; mcpServers: Record<string, unknown> };
    expect(remaining.account).toBe("preserve");
    expect(remaining.mcpServers.existing).toBeDefined();
    expect(remaining.mcpServers).not.toHaveProperty(
      "notion-acceptance-test-mcp",
    );

    const recover = run(["recover", "--yes", "--json"], isolated.env);
    expect([0, 1]).toContain(recover.status);
  });

  it("installs Claude Code user scope with lifecycle and JSON output preserved", async () => {
    const isolated = await isolatedEnvironment("primary");
    isolated.env.MCPGET_CLAUDE_CODE_CONFIG_PATH = join(
      isolated.home,
      ".claude.json",
    );
    await writeFile(
      isolated.env.MCPGET_CLAUDE_CODE_CONFIG_PATH,
      JSON.stringify({
        account: "preserve",
        mcpServers: {
          existing: { type: "stdio", command: "node", args: ["keep.js"] },
        },
      }),
    );

    const install = run(
      [
        "install",
        "com.notion/acceptance-test",
        "claude-code",
        "--scope",
        "user",
        "--candidate",
        "com.notion/acceptance-test",
        "--source",
        "remote",
        "--yes",
        "--json",
      ],
      isolated.env,
    );
    expect(install.status).toBe(0);
    const payload = parseJson(install);
    expectEnvelope(payload, "install", true);
    expect(payload.data.configuration).toMatchObject({
      scope: "user",
      status: "completed",
    });
    const written = JSON.parse(
      await readFile(isolated.env.MCPGET_CLAUDE_CODE_CONFIG_PATH, "utf8"),
    ) as {
      account: string;
      mcpServers: Record<string, unknown>;
    };
    expect(written.account).toBe("preserve");
    expect(written.mcpServers.existing).toBeDefined();
    expect(written.mcpServers["notion-acceptance-test-mcp"]).toBeDefined();
  });

  it("resolves known Notion domains to the same service search", async () => {
    const { env } = await isolatedEnvironment("primary");

    for (const query of [
      "notion",
      "notion.com",
      "www.notion.com",
      "notion.so",
      "www.notion.so",
    ]) {
      const search = run(["search", query, "--json"], env);
      expect(search.status).toBe(0);
      const payload = parseJson(search);
      expectEnvelope(payload, "search", true);
      expect(payload.data.service.name).toBe("Notion");
      expect(payload.data.summary.matchedCandidates).toBeGreaterThan(0);
      expect(payload.data.candidates[0].registryIdentifier).toBe(
        "com.notion/acceptance-test",
      );
    }

    const unknown = run(["search", "docs.unknown.example", "--json"], env);
    expect(unknown.status).toBe(0);
    const unknownPayload = parseJson(unknown);
    expectEnvelope(unknownPayload, "search", true);
    expect(unknownPayload.data.summary.matchedCandidates).toBe(0);
  });

  it("discovers, inspects, installs, lists, and removes a controlled remote server", async () => {
    const { codexHome, env } = await isolatedEnvironment("primary");
    await writeFile(
      join(codexHome, "config.toml"),
      'model = "keep"\n\n[mcp_servers.existing]\nurl = "https://example.test/mcp"\n',
    );

    const search = run(["search", "notion.so", "--json"], env);
    expect(search.status).toBe(0);
    const searchPayload = parseJson(search);
    expectEnvelope(searchPayload, "search", true);
    const candidateId =
      searchPayload.data.recommendation.candidateId ??
      searchPayload.data.candidates[0]?.registryIdentifier;
    expect(candidateId).toBe("com.notion/acceptance-test");

    const inspect = run(
      ["inspect", candidateId, "--for", "notion.so", "--json"],
      env,
    );
    expect(inspect.status).toBe(0);
    const inspectPayload = parseJson(inspect);
    expectEnvelope(inspectPayload, "inspect", true);
    expect(inspectPayload.data.server.registryIdentifier).toBe(candidateId);
    expect(inspectPayload.data.operational.remoteEndpoints).toContain(
      "https://93.184.216.34/mcp",
    );

    const install = run(
      [
        "install",
        candidateId,
        "codex",
        "--candidate",
        candidateId,
        "--source",
        "remote",
        "--yes",
        "--json",
      ],
      env,
    );
    expect(install.status).toBe(0);
    const installPayload = parseJson(install);
    expectEnvelope(installPayload, "install", true);
    expect(installPayload.data.configuration.status).toBe("completed");
    expect(installPayload.data.states.connection_verified.status).toBe(
      "completed",
    );
    expect(installPayload.data.installation).toMatchObject({
      remoteEndpoint: "https://93.184.216.34/mcp",
      remoteEndpointTrust: "public_https",
    });

    const configPath = join(codexHome, "config.toml");
    const config = await readFile(configPath, "utf8");
    expect(config).toContain('model = "keep"');
    expect(config).toContain("[mcp_servers.existing]");
    expect(config).toContain("[mcp_servers.notion-acceptance-test-mcp]");
    expect(config).toContain('url = "https://93.184.216.34/mcp"');

    const list = run(["list", "codex", "--json"], env);
    expect(list.status).toBe(0);
    const listPayload = parseJson(list);
    expectEnvelope(listPayload, "list", true);
    expect(
      (
        listPayload.data as {
          servers: Array<{ name: string }>;
        }
      ).servers.some((server) => server.name === "notion-acceptance-test-mcp"),
    ).toBe(true);

    const remove = run(
      ["remove", "notion-acceptance-test-mcp", "codex", "--yes", "--json"],
      env,
    );
    expect(remove.status).toBe(0);
    const removePayload = parseJson(remove);
    expectEnvelope(removePayload, "remove", true);
    expect(removePayload.data.removed).toBe(true);

    const remaining = await readFile(configPath, "utf8");
    expect(remaining).not.toContain("[mcp_servers.notion-acceptance-test-mcp]");
    expect(remaining).toContain("[mcp_servers.existing]");
  });

  it("requires --yes for install and remove in non-interactive JSON mode", async () => {
    const { codexHome, env } = await isolatedEnvironment("primary");
    await writeFile(
      join(codexHome, "config.toml"),
      '[mcp_servers.existing]\nurl = "https://example.test/mcp"\n',
    );

    const install = run(
      [
        "install",
        "com.notion/acceptance-test",
        "codex",
        "--candidate",
        "com.notion/acceptance-test",
        "--source",
        "remote",
        "--json",
      ],
      env,
    );
    expect(install.status).toBe(4);
    const installPayload = parseJson(install);
    expectEnvelope(installPayload, "install", false);
    expect(installPayload.error.code).toBe("MISSING_REQUIRED_INPUT");

    const remove = run(["remove", "existing", "codex", "--json"], env);
    expect(remove.status).toBe(4);
    const removePayload = parseJson(remove);
    expectEnvelope(removePayload, "remove", false);
    expect(removePayload.error.code).toBe("MISSING_REQUIRED_INPUT");
  });

  it("redacts configured endpoint credentials for every client in JSON and human list output", async () => {
    const isolated = await isolatedEnvironment();
    const endpoint =
      "https://user-info-secret:password-secret@example.com/mcp?token=query-token-secret&region=us#access_token=fragment-token-secret";
    const configurations = [
      {
        client: "codex",
        path: join(isolated.codexHome, "config.toml"),
        contents: `[mcp_servers.remote]\nurl = ${JSON.stringify(endpoint)}\n`,
      },
      {
        client: "claude",
        path: join(
          isolated.home,
          ".config",
          "Claude",
          "claude_desktop_config.json",
        ),
        contents: `${JSON.stringify({
          mcpServers: { remote: { url: endpoint } },
        })}\n`,
      },
      {
        client: "cursor",
        path: join(isolated.home, ".cursor", "mcp.json"),
        contents: `${JSON.stringify({
          mcpServers: { remote: { url: endpoint } },
        })}\n`,
      },
    ];
    const secrets = [
      "user-info-secret",
      "password-secret",
      "query-token-secret",
      "fragment-token-secret",
    ];

    for (const configuration of configurations) {
      await mkdir(join(configuration.path, ".."), { recursive: true });
      await writeFile(configuration.path, configuration.contents);
      const json = run(["list", configuration.client, "--json"], isolated.env);
      expect(json.status).toBe(0);
      const payload = parseJson(json);
      expectEnvelope(payload, "list", true);
      expect(JSON.stringify(payload)).toContain("region=us");
      for (const secret of secrets) {
        expect(json.stdout).not.toContain(secret);
      }

      const human = run(["list", configuration.client], isolated.env);
      expect(human.status).toBe(0);
      expect(human.stderr).toBe("");
      expect(human.stdout).toContain("region=us");
      for (const secret of secrets) {
        expect(human.stdout).not.toContain(secret);
      }
      expect(await readFile(configuration.path, "utf8")).toBe(
        configuration.contents,
      );
    }
  });

  it("does not let --yes bypass the remote destination policy", async () => {
    const { env } = await isolatedEnvironment();
    const result = run(
      ["install", "https://127.0.0.1/mcp", "codex", "--yes", "--json"],
      env,
    );
    expect(result.status).toBe(2);
    const payload = parseJson(result);
    expectEnvelope(payload, "install", false);
    expect(payload.error.code).toBe("INVALID_INPUT");
    expect(payload.error.message).toMatch(/loopback|private|local-network/i);
  });

  it("rejects direct endpoint credentials before output or persistence", async () => {
    const isolated = await isolatedEnvironment();
    const credentials = {
      code: "authorization-code-secret",
      code_verifier: "pkce-verifier-secret",
      access_token: "access-token-secret",
      refresh_token: "refresh-token-secret",
      client_secret: "client-secret-value",
      token: "generic-token-secret",
      authorization: "authorization-header-secret",
    };
    const query = new URLSearchParams(credentials);
    query.set("region", "us");
    const result = run(
      [
        "install",
        `https://93.184.216.34/mcp?${query.toString()}`,
        "codex",
        "--yes",
        "--json",
      ],
      isolated.env,
    );
    expect(result.status).toBe(2);
    const payload = parseJson(result);
    expectEnvelope(payload, "install", false);
    expect(payload.error.code).toBe("INVALID_INPUT");
    for (const secret of Object.values(credentials)) {
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
      expect(JSON.stringify(payload)).not.toContain(secret);
    }
    await expect(access(join(isolated.home, ".mcpget"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(join(isolated.home, ".mcpget-data")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(isolated.codexHome, "config.toml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects ambiguous candidates and invalid candidate IDs", async () => {
    const ambiguous = await isolatedEnvironment("ambiguous");
    const search = run(["search", "notion.so", "--json"], ambiguous.env);
    expect(search.status).toBe(0);
    const searchPayload = parseJson(search);
    expect(searchPayload.data.candidates.length).toBeGreaterThanOrEqual(2);

    const install = run(
      ["install", "notion.com", "codex", "--yes", "--json"],
      ambiguous.env,
    );
    expect(install.status).toBe(2);
    const installPayload = parseJson(install);
    expectEnvelope(installPayload, "install", false);
    expect(installPayload.error.code).toBe("INVALID_INPUT");

    const invalid = await isolatedEnvironment("invalid-candidate");
    const invalidInstall = run(
      [
        "install",
        "com.notion/missing",
        "codex",
        "--candidate",
        "com.notion/missing",
        "--source",
        "remote",
        "--yes",
        "--json",
      ],
      invalid.env,
    );
    expect(invalidInstall.status).toBe(1);
    const invalidPayload = parseJson(invalidInstall);
    expectEnvelope(invalidPayload, "install", false);
  });

  it("rejects unsupported sources and reports missing credentials honestly", async () => {
    const unsupported = await isolatedEnvironment("primary");
    const unsupportedInstall = run(
      [
        "install",
        "com.notion/acceptance-test",
        "codex",
        "--candidate",
        "com.notion/acceptance-test",
        "--source",
        "pypi:not-a-package",
        "--yes",
        "--json",
      ],
      unsupported.env,
    );
    expect(unsupportedInstall.status).toBe(3);
    const unsupportedPayload = parseJson(unsupportedInstall);
    expectEnvelope(unsupportedPayload, "install", false);
    expect(unsupportedPayload.error.code).toBe("UNSUPPORTED_OPERATION");

    const missing = await isolatedEnvironment("missing-credential");
    const missingInstall = run(
      [
        "install",
        "com.notion/acceptance-test",
        "codex",
        "--candidate",
        "com.notion/acceptance-test",
        "--source",
        "remote",
        "--yes",
        "--json",
      ],
      missing.env,
    );
    expect(missingInstall.status).toBe(4);
    const missingPayload = parseJson(missingInstall);
    expectEnvelope(missingPayload, "install", false);
    expect(missingPayload.error.code).toBe("MISSING_REQUIRED_INPUT");
  });

  it("does not expose secrets and does not hide invalid configuration failures", async () => {
    const invalidConfig = await isolatedEnvironment("primary");
    await writeFile(
      join(invalidConfig.codexHome, "config.toml"),
      "[mcp_servers.\n",
    );
    const install = run(
      [
        "install",
        "com.notion/acceptance-test",
        "codex",
        "--candidate",
        "com.notion/acceptance-test",
        "--source",
        "remote",
        "--yes",
        "--json",
      ],
      invalidConfig.env,
    );
    expect(install.status).toBe(1);
    const payload = parseJson(install);
    expectEnvelope(payload, "install", false);
    expect(JSON.stringify(payload)).not.toContain("ACCEPTANCE_SECRET");

    const after = await readFile(
      join(invalidConfig.codexHome, "config.toml"),
      "utf8",
    );
    expect(after).toBe("[mcp_servers.\n");
  });

  it("fails safely when the Codex configuration path is inaccessible", async () => {
    const isolated = await isolatedEnvironment("primary");
    await rm(isolated.codexHome, { recursive: true, force: true });
    await writeFile(isolated.codexHome, "blocker");
    const install = run(
      [
        "install",
        "com.notion/acceptance-test",
        "codex",
        "--candidate",
        "com.notion/acceptance-test",
        "--source",
        "remote",
        "--yes",
        "--json",
      ],
      isolated.env,
    );
    expect(install.status).toBe(1);
    const payload = parseJson(install);
    expectEnvelope(payload, "install", false);
  });

  it("reports MCP verification failure without accidental success", async () => {
    const isolated = await isolatedEnvironment("failure");
    const install = run(
      [
        "install",
        "com.notion/acceptance-test",
        "codex",
        "--candidate",
        "com.notion/acceptance-test",
        "--source",
        "remote",
        "--yes",
        "--json",
      ],
      isolated.env,
    );
    expect(install.status).toBe(1);
    const payload = parseJson(install);
    expectEnvelope(payload, "install", false);
  });

  it("returns correct JSON exit behavior for nonexistent removal", async () => {
    const isolated = await isolatedEnvironment("primary");
    await writeFile(
      join(isolated.codexHome, "config.toml"),
      'model = "keep"\n',
    );
    const remove = run(
      ["remove", "missing-server", "codex", "--yes", "--json"],
      isolated.env,
    );
    expect(remove.status).toBe(2);
    const payload = parseJson(remove);
    expectEnvelope(payload, "remove", false);
    expect(payload.error.code).toBe("INVALID_INPUT");
  });
});
