import { chmod, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error(`Configuration at ${path} is not valid JSON; it was left unchanged.`); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Configuration at ${path} must contain a JSON object; it was left unchanged.`);
  }
  return value as Record<string, unknown>;
}

export async function writeJsonSafely(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let hadOriginal = false;
  try { await readFile(path); hadOriginal = true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const backup = `${path}.mcpget.bak`;
  if (hadOriginal) {
    await copyFile(path, backup);
    await chmod(backup, 0o600);
  }
  const temp = `${path}.mcpget-${process.pid}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
    const verified = await readJsonObject(path);
    if (JSON.stringify(verified) !== JSON.stringify(value)) throw new Error("Written configuration did not validate.");
  } catch (error) {
    if (hadOriginal) await copyFile(backup, path);
    else await unlink(path).catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}
