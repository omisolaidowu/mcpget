import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run this manual end-to-end test in an interactive terminal.");

const tempHome = await mkdtemp(join(tmpdir(), "mcpget-real-install-"));
const cli = resolve("dist", "cli", "index.js");
const configPath = join(tempHome, ".cursor", "mcp.json");
const statePath = join(tempHome, ".mcpget", "installations.json");
console.log("Isolated real-server installation test");
console.log("Cursor config and MCPGet state will be written under a temporary home and removed afterward.");
console.log("The CLI will display the pinned package, exact command, and request explicit confirmation before execution.");

try {
  const code = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(process.execPath, [cli, "install", "npm:@modelcontextprotocol/server-everything@2.3.1", "cursor"], {
      shell: false,
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        USERPROFILE: tempHome,
        HOME: tempHome,
        APPDATA: join(tempHome, "AppData", "Roaming"),
        NPM_CONFIG_CACHE: join(tempHome, "npm-cache"),
      },
    });
    child.once("error", reject);
    child.once("exit", (status) => resolveExit(status ?? 1));
  });
  if (code !== 0) throw new Error(`The end-to-end install command exited with status ${code}.`);
  const config = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers?: Record<string, unknown> };
  const state = JSON.parse(await readFile(statePath, "utf8")) as {
    installations?: Array<{
      states?: {
        configured?: { status?: string };
        connection_verified?: { status?: string };
      };
    }>;
  };
  const record = state.installations?.[0];
  if (!config.mcpServers || Object.keys(config.mcpServers).length !== 1) throw new Error("The temporary Cursor configuration did not contain exactly one MCP server.");
  if (record?.states.configured?.status !== "completed" || record.states.connection_verified?.status !== "completed") throw new Error("The durable state record did not report verified connection and configuration.");
  console.log(`\nManual end-to-end result: configuration and MCP connection verified in isolated temp profile ${dirname(configPath)}.`);
} finally {
  await rm(tempHome, { recursive: true, force: true });
}
