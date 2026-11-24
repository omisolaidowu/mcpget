import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInstallationRecord } from "../../src/models/installation.js";
import { InstallationStateStore } from "../../src/installers/state-store.js";
import { reportStates } from "../../src/cli/commands/install.js";

describe("installation state tracking", () => {
  it("records inapplicable states explicitly and persists independent progress", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcpget-state-"));
    const path = join(directory, "installations.json");
    try {
      const record = createInstallationRecord({
        id: "publisher/server", serverIdentifier: "publisher/server", displayName: "Server",
        client: "cursor", source: "npm package", strategy: "ephemeral", configName: "server",
        configPath: join(directory, "mcp.json"), configScope: "user",
      });
      expect(record.states.installed.status).toBe("not_applicable");
      expect(record.states.setup_required.status).toBe("not_verified");
      record.states.setup_required = { status: "setup_required", detail: "Required environment variable: API_KEY." };
      record.states.connection_verified = { status: "completed", detail: "MCP initialize succeeded." };
      record.states.configured = { status: "failed", detail: "Configuration was rejected." };
      const store = new InstallationStateStore(path);
      await store.put(record);
      const restored = await store.get("publisher/server", "cursor");
      expect(restored?.states.connection_verified.status).toBe("completed");
      expect(restored?.states.configured.status).toBe("failed");
      expect(restored?.states.setup_required.status).toBe("setup_required");
      expect(await readFile(path, "utf8")).not.toContain("token");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("updates and removes one client record without affecting another", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcpget-state-"));
    try {
      const store = new InstallationStateStore(join(directory, "installations.json"));
      const base = {
        id: "publisher/server", serverIdentifier: "publisher/server", displayName: "Server",
        source: "Remote endpoint", strategy: "remote" as const, configName: "server",
        configPath: join(directory, "config"), configScope: "user" as const,
      };
      await store.put(createInstallationRecord({ ...base, client: "cursor" }));
      await store.put(createInstallationRecord({ ...base, client: "codex" }));
      await store.delete("publisher/server", "cursor");
      expect((await store.all()).map((item) => item.client)).toEqual(["codex"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("reports supplied credential setup without claiming authentication", () => {
    const record = createInstallationRecord({
      id: "thunderbit", serverIdentifier: "thunderbit", displayName: "Thunderbit",
      client: "claude", source: "npm package", strategy: "managed",
      configName: "thunderbit", configPath: "claude.json", configScope: "user",
    });
    record.states.installed = { status: "completed", detail: "Managed package installed." };
    record.states.configured = { status: "completed", detail: "Client entry independently reread." };
    record.states.setup_required = { status: "completed", detail: "Required environment configuration independently verified for: THUNDERBIT_API_KEY." };
    record.states.startup_verified = { status: "completed", detail: "Process started." };
    record.states.connection_verified = { status: "completed", detail: "MCP protocol initialized." };
    record.states.authenticated = { status: "not_verified", detail: "MCP initialization does not verify authentication." };

    const output = reportStates(record);
    expect(output).toContain("THUNDERBIT_API_KEY");
    expect(output).toContain("[NOT_VERIFIED] authenticated");
    expect(output).toContain("AUTHENTICATION NOT VERIFIED");
    expect(output).not.toContain("No documented authentication or credential setup was identified.");
    expect(output).not.toContain("[object Object]");
  });

  it("reports missing required credentials without marking authentication successful", () => {
    const record = createInstallationRecord({
      id: "thunderbit", serverIdentifier: "thunderbit", displayName: "Thunderbit",
      client: "claude", source: "npm package", strategy: "managed",
      configName: "thunderbit", configPath: "claude.json", configScope: "user",
    });
    record.states.installed = { status: "completed", detail: "Managed package installed." };
    record.states.configured = { status: "completed", detail: "Config written without missing value." };
    record.states.setup_required = { status: "setup_required", detail: "Missing required environment variable: THUNDERBIT_API_KEY." };
    record.states.authenticated = { status: "not_verified", detail: "Authentication was not independently verified." };
    const output = reportStates(record);
    expect(output).toContain("REQUIRED SETUP IS PENDING");
    expect(output).toContain("THUNDERBIT_API_KEY");
    expect(output).toContain("[NOT_VERIFIED] authenticated");
    expect(output).not.toContain("[object Object]");
  });

  it("reports successful installation and protocol verification separately from configuration failure", () => {
    const record = createInstallationRecord({
      id: "thunderbit", serverIdentifier: "thunderbit", displayName: "Thunderbit",
      client: "codex", source: "npm package", strategy: "managed",
      configName: "thunderbit", configPath: "config.toml", configScope: "user",
    });
    record.states.installed = { status: "completed", detail: "Managed package installed." };
    record.states.configured = { status: "failed", detail: "Codex configuration update failed and was rolled back." };
    record.states.connection_verified = { status: "completed", detail: "MCP protocol initialized." };
    record.states.authenticated = { status: "not_verified", detail: "Authentication was not independently verified." };
    const output = reportStates(record);
    expect(output).toContain("INSTALLATION COMPLETED; CLIENT CONFIGURATION FAILED; MCP PROTOCOL VERIFICATION COMPLETED; AUTHENTICATION NOT VERIFIED");
    expect(output).toContain("[COMPLETED] installed");
    expect(output).toContain("[FAILED] configured");
    expect(output).not.toContain("Result: INSTALLATION INCOMPLETE");
  });
});
