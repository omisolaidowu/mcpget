import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInstallationRecord } from "../../src/models/installation.js";
import { detectExistingServerMatches } from "../../src/installers/existing-server-detection.js";
import { CodexAdapter } from "../../src/installers/codex-adapter.js";
import { JsonClientAdapter } from "../../src/installers/json-client-adapter.js";
import {
  normalizeServerRegistration,
  type ExistingServerRegistration,
} from "../../src/installers/types.js";
import type { InstallationRecord } from "../../src/models/installation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "mcpget-existing-registration-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function registration(
  name: string,
  configPath: string,
  entry: Parameters<typeof normalizeServerRegistration>[3],
  client: "claude" | "codex" | "cursor" = "codex",
): ExistingServerRegistration {
  return normalizeServerRegistration(client, configPath, "user", {
    name,
    ...entry,
  });
}

function record(input: {
  id: string;
  configName: string;
  configPath: string;
  client?: "claude" | "codex" | "cursor";
  packageIdentifier?: string;
  installationPath?: string;
}): InstallationRecord {
  return createInstallationRecord({
    id: input.id,
    serverIdentifier: input.id,
    displayName: input.configName,
    client: input.client ?? "codex",
    source: "test",
    strategy: "managed",
    configName: input.configName,
    configPath: input.configPath,
    configScope: "user",
    ...(input.packageIdentifier
      ? { packageIdentifier: input.packageIdentifier }
      : {}),
    ...(input.installationPath
      ? { installationPath: input.installationPath }
      : {}),
  });
}

describe("existing MCP registration identity classification", () => {
  it("confirms the same Registry identity when its recorded managed path still matches", () => {
    const configPath = "C:\\codex\\config.toml";
    const installationPath = "C:\\mcpget\\packages\\server";
    const matches = detectExistingServerMatches(
      "publisher/notion-tools",
      {
        name: "notion-tools",
        command: "node",
        args: [],
      },
      "@publisher/notion-tools",
      [
        registration("different-label", configPath, {
          command: "node",
          args: [path.join(installationPath, "server.js")],
        }),
      ],
      [
        record({
          id: "publisher/notion-tools",
          configName: "different-label",
          configPath,
          installationPath,
        }),
      ],
    );

    expect(matches).toMatchObject([
      { classification: "confirmed_duplicate", name: "different-label" },
    ]);
  });

  it("keeps a different Registry ID with a matching launch as a possible match", () => {
    const configPath = "C:\\codex\\config.toml";
    const matches = detectExistingServerMatches(
      "publisher/notion-tools",
      { name: "notion-tools", command: "node", args: ["server.js"] },
      "@publisher/notion-tools",
      [
        registration("other-notion-tools", configPath, {
          command: "node",
          args: ["server.js"],
        }),
      ],
      [
        record({
          id: "another-publisher/notion-tools",
          configName: "other-notion-tools",
          configPath,
        }),
      ],
    );

    expect(matches).toMatchObject([
      { classification: "possible_duplicate", name: "other-notion-tools" },
    ]);
  });

  it("classifies an exact endpoint under another name as possible, not confirmed", () => {
    const configPath = "/home/user/.cursor/mcp.json";
    const matches = detectExistingServerMatches(
      "vendor/new-notion-server",
      {
        name: "new-notion-server",
        url: "https://mcp.example.com/api",
        transport: "streamable-http",
      },
      undefined,
      [
        registration(
          "existing-remote",
          configPath,
          {
            url: "https://mcp.example.com/api",
            transport: "streamable_http",
          },
          "cursor",
        ),
      ],
      [],
    );

    expect(matches).toMatchObject([
      { classification: "possible_duplicate", name: "existing-remote" },
    ]);
  });

  it("reports a same-name entry with a conflicting Registry identity as a name conflict", () => {
    const configPath = "/home/user/.config/claude.json";
    const matches = detectExistingServerMatches(
      "vendor/new-server",
      { name: "existing", command: "node", args: ["new.js"] },
      undefined,
      [
        registration(
          "existing",
          configPath,
          {
            command: "node",
            args: ["old.js"],
          },
          "claude",
        ),
      ],
      [
        record({
          id: "vendor/old-server",
          configName: "existing",
          configPath,
          client: "claude",
        }),
      ],
    );

    expect(matches).toMatchObject([
      { classification: "name_conflict", name: "existing" },
    ]);
  });

  it("recognizes npm references with different versions as possible matches", () => {
    const configPath = "/home/user/.codex/config.toml";
    const matches = detectExistingServerMatches(
      "publisher/notion-server",
      {
        name: "new-name",
        command: "npx",
        args: ["--yes", "--", "@vendor/notion-mcp@2.0.0"],
      },
      "@vendor/notion-mcp",
      [
        registration("older-name", configPath, {
          command: "npx",
          args: ["--yes", "--", "@vendor/notion-mcp@1.2.0"],
        }),
      ],
      [],
    );

    expect(matches).toMatchObject([
      { classification: "possible_duplicate", name: "older-name" },
    ]);
  });

  it.each(["claude", "cursor", "codex"] as const)(
    "allows distinct Notion servers with distinct packages to coexist in %s",
    (client) => {
      const configPath = `/home/user/${client}/mcp.json`;
      const matches = detectExistingServerMatches(
        "publisher/notion-database",
        {
          name: "notion-database",
          command: "node",
          args: ["/managed/notion-database/server.js"],
        },
        "@publisher/notion-database",
        [
          registration(
            "notion-search",
            configPath,
            {
              command: "node",
              args: ["/managed/notion-search/server.js"],
            },
            client,
          ),
        ],
        [
          record({
            id: "another/notion-search",
            configName: "notion-search",
            configPath,
            client,
            packageIdentifier: "@another/notion-search",
            installationPath: "/managed/notion-search",
          }),
        ],
      );

      expect(matches).toEqual([]);
    },
  );

  it.each(["claude", "cursor", "codex"] as const)(
    "does not flag distinct Notion registrations read from the %s configuration",
    async (client) => {
      const directory = await temporaryDirectory();
      const configPath = path.join(directory, "config");
      let adapter: JsonClientAdapter | CodexAdapter;
      if (client === "codex") {
        await writeFile(
          configPath,
          [
            "[mcp_servers.notion-search]",
            'command = "node"',
            'args = ["/managed/notion-search/server.js"]',
            "",
          ].join("\n"),
        );
        adapter = new CodexAdapter(configPath);
      } else {
        await writeFile(
          configPath,
          JSON.stringify({
            mcpServers: {
              "notion-search": {
                command: "node",
                args: ["/managed/notion-search/server.js"],
              },
            },
          }),
        );
        adapter = new JsonClientAdapter(client, client, configPath);
      }

      const registrations = await adapter.readRegistrations();
      const matches = detectExistingServerMatches(
        "publisher/notion-database",
        {
          name: "notion-database",
          command: "node",
          args: ["/managed/notion-database/server.js"],
        },
        "@publisher/notion-database",
        registrations,
        [],
      );

      expect(registrations.map((item) => item.name)).toEqual(["notion-search"]);
      expect(matches).toEqual([]);
    },
  );

  it.each(["claude", "cursor", "codex"] as const)(
    "classifies a matching package read from the %s configuration as possible",
    async (client) => {
      const directory = await temporaryDirectory();
      const configPath = path.join(directory, "config");
      let adapter: JsonClientAdapter | CodexAdapter;
      if (client === "codex") {
        await writeFile(
          configPath,
          [
            "[mcp_servers.existing-alias]",
            'command = "npx"',
            'args = ["--yes", "--", "@vendor/notion-mcp@1.2.0"]',
            "",
          ].join("\n"),
        );
        adapter = new CodexAdapter(configPath);
      } else {
        await writeFile(
          configPath,
          JSON.stringify({
            mcpServers: {
              "existing-alias": {
                command: "npx",
                args: ["--yes", "--", "@vendor/notion-mcp@1.2.0"],
              },
            },
          }),
        );
        adapter = new JsonClientAdapter(client, client, configPath);
      }

      const matches = detectExistingServerMatches(
        "publisher/notion-database",
        {
          name: "notion-database",
          command: process.execPath,
          args: [],
        },
        "@vendor/notion-mcp",
        await adapter.readRegistrations(),
        [],
      );

      expect(matches).toMatchObject([
        {
          classification: "possible_duplicate",
          name: "existing-alias",
          configPath,
        },
      ]);
    },
  );

  it("exposes environment variable names but never values from adapter registrations", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, "mcp.json");
    const secret = "never-expose-this-secret";
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          notion: {
            command: "node",
            args: ["server.js"],
            env: { NOTION_TOKEN: secret },
          },
        },
      }),
    );
    const adapter = new JsonClientAdapter("cursor", "Cursor", configPath);

    const registrations = await adapter.readRegistrations();

    expect(registrations[0]?.environmentVariableNames).toEqual([
      "NOTION_TOKEN",
    ]);
    expect(JSON.stringify(registrations)).not.toContain(secret);
  });
});
