import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { RegistryInputRequirement } from "../models/server-candidate.js";

export interface ManagedNpmResult {
  directory: string;
  packageIdentifier: string;
  installedVersion: string;
  command: string;
  args: string[];
  reused: boolean;
  documentedRequirements?: RegistryInputRequirement[];
}
export interface ManagedNpmOptions { installRoot?: string; runInstaller?: (directory: string, reference: string, timeoutMs: number) => Promise<void> }
interface PackageMetadata { name?: unknown; version?: unknown; bin?: unknown }
interface ManagedMetadata {
  schemaVersion: 1;
  packageIdentifier: string;
  requestedVersion?: string;
  installedVersion: string;
  installationType: "npm";
  installationLocation: string;
  installedAt: string;
  servers: Array<{ serverIdentifier: string; serverName: string; clients: string[]; configurationEntries: string[]; verificationStatus: string; lastVerifiedAt?: string }>;
}

export function managedInstallRoot(): string {
  if (process.env.MCPGET_DATA_DIR) return join(process.env.MCPGET_DATA_DIR, "installations");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "MCPGet", "installations");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "mcpget", "installations");
}
export function managedInstallPath(identifier: string, requestedVersion?: string, root = managedInstallRoot()): string {
  const reference = `${identifier}${requestedVersion ? `@${requestedVersion}` : ""}`;
  const key = createHash("sha256").update(`npm|${reference}`).digest("hex").slice(0, 24);
  return join(root, key);
}

export async function findManagedNpm(identifier: string, requestedVersion?: string, installRoot = managedInstallRoot()): Promise<ManagedNpmResult | undefined> {
  const directory = managedInstallPath(identifier, requestedVersion, installRoot);
  const metadataPath = join(directory, "mcpget-installation.json");
  let metadata: ManagedMetadata;
  try { metadata = JSON.parse(await readFile(metadataPath, "utf8")) as ManagedMetadata; }
  catch { return undefined; }
  if (metadata.schemaVersion !== 1 || metadata.packageIdentifier !== identifier || metadata.installationLocation !== directory) return undefined;
  let resolvedPackage: { version: string; bin: string };
  try { resolvedPackage = await resolveInstalledPackage(directory, identifier); } catch { return undefined; }
  return { directory, packageIdentifier: identifier, installedVersion: resolvedPackage.version, command: process.execPath, args: [resolvedPackage.bin], reused: true, documentedRequirements: await readDocumentedRequirements(directory, identifier) };
}

export async function installManagedNpm(identifier: string, requestedVersion?: string, timeoutMs = 180_000, options: ManagedNpmOptions = {}): Promise<ManagedNpmResult> {
  const reference = `${identifier}${requestedVersion ? `@${requestedVersion}` : ""}`;
  const root = options.installRoot ?? managedInstallRoot();
  const directory = managedInstallPath(identifier, requestedVersion, root);
  const metadataPath = join(directory, "mcpget-installation.json");
  const existing = await findManagedNpm(identifier, requestedVersion, root);
  if (existing) return existing;
  await mkdir(directory, { recursive: true });
  try {
    await (options.runInstaller ?? ((target, ref, timeout) => {
      const [command, args] = npmInvocation(target, ref);
      return run(command, args, timeout);
    }))(directory, reference, timeoutMs);
    const installed = await resolveInstalledPackage(directory, identifier);
    const metadata: ManagedMetadata = {
      schemaVersion: 1, packageIdentifier: identifier,
      ...(requestedVersion ? { requestedVersion } : {}), installedVersion: installed.version,
      installationType: "npm", installationLocation: directory, installedAt: new Date().toISOString(), servers: [],
    };
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return { directory, packageIdentifier: identifier, installedVersion: installed.version, command: process.execPath, args: [installed.bin], reused: false, documentedRequirements: await readDocumentedRequirements(directory, identifier) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function updateManagedMetadata(result: ManagedNpmResult, server: { serverIdentifier: string; serverName: string; client: string; configurationEntry: string; verificationStatus: string; lastVerifiedAt?: string }): Promise<void> {
  const path = join(result.directory, "mcpget-installation.json");
  const metadata = JSON.parse(await readFile(path, "utf8")) as ManagedMetadata;
  let item = metadata.servers.find((value) => value.serverIdentifier === server.serverIdentifier);
  if (!item) {
    item = { serverIdentifier: server.serverIdentifier, serverName: server.serverName, clients: [], configurationEntries: [], verificationStatus: server.verificationStatus };
    metadata.servers.push(item);
  }
  if (!item.clients.includes(server.client)) item.clients.push(server.client);
  if (!item.configurationEntries.includes(server.configurationEntry)) item.configurationEntries.push(server.configurationEntry);
  item.verificationStatus = server.verificationStatus;
  if (server.lastVerifiedAt) item.lastVerifiedAt = server.lastVerifiedAt;
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function releaseManagedAssociation(installationPath: string, serverIdentifier: string, client: string, configurationEntry?: string): Promise<boolean> {
  const root = resolve(managedInstallRoot());
  const target = resolve(installationPath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("Refusing to remove a path outside MCPGet's managed installation directory.");
  const metadataPath = join(target, "mcpget-installation.json");
  let metadata: ManagedMetadata;
  try { metadata = JSON.parse(await readFile(metadataPath, "utf8")) as ManagedMetadata; } catch { return false; }
  const item = metadata.servers.find((value) => value.serverIdentifier === serverIdentifier);
  if (item) {
    if (configurationEntry) item.configurationEntries = item.configurationEntries.filter((value) => value !== configurationEntry);
    item.clients = item.clients.filter((value) => value !== client);
    if (!item.clients.length && !item.configurationEntries.length) metadata.servers = metadata.servers.filter((value) => value !== item);
  }
  if (metadata.servers.length) {
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return false;
  }
  await rm(target, { recursive: true, force: true });
  return true;
}

async function resolveInstalledPackage(directory: string, identifier: string): Promise<{ version: string; bin: string }> {
  const packageDir = join(directory, "node_modules", ...identifier.split("/"));
  const metadata = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as PackageMetadata;
  if (metadata.name !== identifier || typeof metadata.version !== "string") throw new Error("npm completed, but the installed package identity or version could not be verified.");
  let binValue: unknown;
  if (typeof metadata.bin === "string") binValue = metadata.bin;
  else if (typeof metadata.bin === "object" && metadata.bin !== null && !Array.isArray(metadata.bin)) {
    const bins = metadata.bin as Record<string, unknown>;
    const preferred = identifier.split("/").at(-1)!.replace(/^mcp-server-/, "");
    binValue = bins[preferred] ?? (Object.keys(bins).length === 1 ? Object.values(bins)[0] : undefined);
  }
  if (typeof binValue !== "string") throw new Error("The installed npm package does not expose an unambiguous executable. Inspect the package documentation before using it.");
  const bin = resolve(packageDir, binValue);
  if (!isAbsolute(bin) || !bin.startsWith(`${resolve(packageDir)}${sep}`)) throw new Error("The npm package executable points outside its installation directory.");
  await readFile(bin);
  return { version: metadata.version, bin };
}

async function readDocumentedRequirements(directory: string, identifier: string): Promise<RegistryInputRequirement[]> {
  const packageDir = join(directory, "node_modules", ...identifier.split("/"));
  let readme: string;
  try { readme = await readFile(join(packageDir, "README.md"), "utf8"); }
  catch { try { readme = await readFile(join(packageDir, "readme.md"), "utf8"); } catch { return []; } }
  const found = new Map<string, RegistryInputRequirement>();
  for (const line of readme.split(/\r?\n/)) {
    if (!/required|must provide|must set|needed/i.test(line) || !/api\s*key|token|credential|secret|environment variable|env var/i.test(line)) continue;
    for (const match of line.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
      found.set(match[0], {
        name: match[0],
        required: true,
        secret: /api\s*key|token|credential|secret|password/i.test(`${line} ${match[0]}`),
        description: line.trim().slice(0, 240),
        deployment: "local-package",
      });
    }
  }
  return [...found.values()].slice(0, 8);
}

function npmInvocation(directory: string, packageReference: string): [string, string[]] {
  const args = ["install", "--prefix", directory, "--no-audit", "--no-fund", "--package-lock=true", packageReference];
  if (process.platform !== "win32") return ["npm", args];
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return [process.execPath, [npmCli, ...args]];
}
function run(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Managed npm installation timed out; the incomplete isolated installation was removed.")); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(new Error(`Could not start the npm runtime: ${error.message}`)); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun();
      else reject(new Error(`Managed npm installation failed with exit code ${code ?? "unknown"}. Review npm's local diagnostics and retry.`));
    });
  });
}
