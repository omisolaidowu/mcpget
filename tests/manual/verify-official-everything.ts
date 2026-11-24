import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createInstallPlan } from "../../src/installers/plan-installer.js";
import type { ServerCandidate } from "../../src/models/server-candidate.js";
import { verifyStdioMcp } from "../../src/verification/mcp-connection.js";

const packageId = "@modelcontextprotocol/server-everything";
const pinnedVersion = "2.3.1";
const candidate: ServerCandidate = {
  name: `manual/${packageId}`,
  title: "MCP reference server (everything)",
  registryIdentifier: `manual/${packageId}`,
  operational: {
    deploymentModels: ["Local package"], transports: ["stdio"],
    packages: [{ registryType: "npm", identifier: packageId, version: pinnedVersion }],
    remoteEndpoints: [], configurationInputs: [], authentication: "Unknown",
    clientCompatibility: "Unknown", setupComplexity: "Unknown",
  },
  sourceRegistry: "npm (version pinned for manual integration test)",
  sourceRecordUrl: "https://www.npmjs.com/package/@modelcontextprotocol/server-everything",
};
const plan = createInstallPlan(candidate);
console.log("Manual real-server MCP integration check");
console.log(`Package: ${packageId}@${pinnedVersion}`);
console.log(`Source: ${candidate.sourceRegistry} · ${candidate.sourceRecordUrl}`);
console.log(`Runtime: ${plan.entry.command}`);
console.log(`Arguments: ${(plan.entry.args ?? []).join(" ")}`);
console.log("This downloads and executes the pinned third-party package through npx. No AI client configuration will be changed.");

if (!stdin.isTTY || !stdout.isTTY) throw new Error("Run this manual test in an interactive terminal to confirm package execution.");
const rl = createInterface({ input: stdin, output: stdout });
let approved = false;
try { approved = /^y(es)?$/i.test((await rl.question("Run this real server now? [y/N] ")).trim()); }
finally { rl.close(); }
if (!approved) { console.log("Cancelled; no package was downloaded or executed."); process.exitCode = 1; }
else {
  const result = await verifyStdioMcp(plan.entry.command!, plan.entry.args!, { timeoutMs: 60_000 });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "connection_verified") process.exitCode = 1;
}
