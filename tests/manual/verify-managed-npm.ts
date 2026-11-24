import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run this manual managed-install test in an interactive terminal.");

const tempHome = await mkdtemp(join(tmpdir(), "mcpget-managed-real-"));
const cli = resolve("dist", "cli", "index.js");
const configPath = join(tempHome, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
const statePath = join(tempHome, ".mcpget", "installations.json");
const managedRoot = join(tempHome, "AppData", "Local", "MCPGet");
console.log("Isolated persistent npm installation test");
console.log("The pinned package will be installed under a temporary MCPGet data directory and removed after verification.");
console.log("The package README documents a required Thunderbit API key; MCPGet will not collect or store it.");
console.log("The CLI will show the identity, managed path, and request explicit confirmation before installing.");

try {
  const code = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(process.execPath, [cli, "install", "npm:@thunderbit/mcp-server@1.0.4", "claude"], {
      shell: false,
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        USERPROFILE: tempHome,
        HOME: tempHome,
        APPDATA: join(tempHome, "AppData", "Roaming"),
        LOCALAPPDATA: managedRoot,
        MCPGET_DATA_DIR: join(tempHome, ".mcpget-data"),
      },
    });
    child.once("error", reject);
    child.once("exit", (status) => resolveExit(status ?? 1));
  });
  if (code !== 0) throw new Error(`Managed install command exited with status ${code}.`);
  const config = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers?: Record<string, { command?: string; args?: string[] }> };
  const state = JSON.parse(await readFile(statePath, "utf8")) as {
    installations?: Array<{
      strategy?: string;
      installationPath?: string;
      installedVersion?: string;
      states?: { installed?: { status?: string }; configured?: { status?: string }; connection_verified?: { status?: string } };
    }>;
  };
  const installation = state.installations?.[0];
  const entry = Object.values(config.mcpServers ?? {})[0];
  if (installation?.strategy !== "managed" || installation.states?.installed?.status !== "completed") throw new Error("Durable state did not report a persistent managed installation.");
  if (installation.states.configured?.status !== "completed" || installation.states.connection_verified?.status !== "completed") throw new Error("Configuration and MCP protocol initialization were not both verified.");
  if (!installation.installationPath || installation.installedVersion !== "1.0.4") throw new Error("Managed installation path/version metadata was missing or incorrect.");
  if (entry?.command !== process.execPath || !entry.args?.[0]?.startsWith(installation.installationPath)) throw new Error("Client config does not point to the managed executable.");
  if (entry.args[0].toLowerCase().includes("npx")) throw new Error("Client config unexpectedly depends on npx.");
  const metadata = JSON.parse(await readFile(join(installation.installationPath, "mcpget-installation.json"), "utf8")) as { installedVersion?: string; servers?: unknown[] };
  if (metadata.installedVersion !== "1.0.4" || !metadata.servers?.length) throw new Error("Managed metadata was incomplete.");
  console.log("\nManual result: persistent package installation, managed executable configuration, and MCP initialization verified.");
} finally {
  await rm(tempHome, { recursive: true, force: true });
}
