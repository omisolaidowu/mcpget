import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { InstallationRecord } from "../models/installation.js";

interface StateFile { schemaVersion: 1; installations: InstallationRecord[] }
const EMPTY: StateFile = { schemaVersion: 1, installations: [] };

export class InstallationStateStore {
  constructor(readonly path = join(homedir(), ".mcpget", "installations.json")) {}
  async all(): Promise<InstallationRecord[]> { return (await this.read()).installations; }
  async get(id: string, client?: string): Promise<InstallationRecord | undefined> {
    return (await this.all()).find((record) => record.id === id && (!client || record.client === client));
  }
  async put(record: InstallationRecord): Promise<void> {
    const file = await this.read();
    const index = file.installations.findIndex((item) => item.id === record.id && item.client === record.client);
    if (index < 0) file.installations.push(record); else file.installations[index] = record;
    await this.write(file);
  }
  async delete(id: string, client: string): Promise<void> {
    const file = await this.read();
    file.installations = file.installations.filter((item) => item.id !== id || item.client !== client);
    await this.write(file);
  }
  private async read(): Promise<StateFile> {
    let raw: string;
    try { raw = await readFile(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY); throw error; }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error("MCPGet installation state is invalid JSON; it was left unchanged."); }
    if (!isStateFile(value)) throw new Error("MCPGet installation state has an unsupported format; it was left unchanged.");
    return value;
  }
  private async write(value: StateFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.path);
  }
}
function isStateFile(value: unknown): value is StateFile {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (value as StateFile).schemaVersion === 1 && Array.isArray((value as StateFile).installations);
}
