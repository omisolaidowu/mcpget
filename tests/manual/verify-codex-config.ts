import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexAdapter } from "../../src/installers/codex-adapter.js";

const tempRoot = await mkdtemp(join(tmpdir(), "mcpget-codex-config-"));
const safeRoot = resolve(tmpdir());
const targetRoot = resolve(tempRoot);
if (!targetRoot.startsWith(`${safeRoot}${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("Refusing to use a temporary directory outside the OS temp root.");
const prior = process.env.CODEX_HOME;
try {
  process.env.CODEX_HOME = tempRoot;
  const target = join(tempRoot, "config.toml");
  await writeFile(target, 'model = "preserve-this-setting"\n');
  const adapter = new CodexAdapter();
  const first = { name: "mcpget-live-probe", url: "https://first.invalid/mcp" };
  const updated = { name: "mcpget-live-probe", url: "https://second.invalid/mcp" };
  await adapter.add(first);
  if (!(await adapter.verify(first)).verified) throw new Error("Codex TOML did not persist the newly added MCP configuration.");
  await adapter.add(updated);
  if (!(await adapter.verify(updated)).verified) throw new Error("Codex TOML did not persist the updated MCP configuration.");
  if (await adapter.verify(first).then((result) => result.verified)) throw new Error("Codex TOML still reported the old URL after the update.");
  if (!await adapter.remove(updated.name) || !await adapter.verifyRemoved(updated.name)) throw new Error("Codex TOML removal could not be independently verified.");
  const config = await readFile(target, "utf8");
  if (!config.includes('model = "preserve-this-setting"')) throw new Error("Codex update did not preserve unrelated user config.");
  console.log("Codex direct-TOML verification passed: user-scope add, update, persisted re-read, and removal without the Codex CLI.");
} finally {
  if (prior === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prior;
  await rm(targetRoot, { recursive: true, force: true });
}
