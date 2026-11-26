import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
  win32 as importPathWin32,
  posix as importPathPosix,
} from "node:path";
import type { RegistryInputRequirement } from "../models/server-candidate.js";
import { getClientAdaptersForContext } from "./adapters.js";
import { renameWithRetry, withFileLock } from "./file-lock.js";

export interface ManagedNpmResult {
  directory: string;
  packageIdentifier: string;
  installedVersion: string;
  command: string;
  args: string[];
  reused: boolean;
  lifecycleScriptsEnabled: boolean;
  documentedRequirements?: RegistryInputRequirement[];
}
export interface ManagedNpmOptions {
  installRoot?: string;
  allowLifecycleScripts?: boolean;
  signal?: AbortSignal;
  runInstaller?: (
    directory: string,
    reference: string,
    timeoutMs: number,
  ) => Promise<void>;
}

export class ManagedNpmCancelledError extends Error {
  constructor(readonly signal: NodeJS.Signals | "ABORT") {
    super("Managed npm installation was cancelled.");
    this.name = "ManagedNpmCancelledError";
  }
}

export class ManagedNpmTerminationError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "MCPGet could not confirm that the npm process tree terminated. The incomplete managed directory was preserved and installation stopped for safety.",
      options,
    );
    this.name = "ManagedNpmTerminationError";
  }
}
interface PackageMetadata {
  name?: unknown;
  version?: unknown;
  bin?: unknown;
}
export interface ManagedServerAssociation {
  serverIdentifier: string;
  serverName: string;
  clients: string[];
  configurationEntries: string[];
  verificationStatus: string;
  lastVerifiedAt?: string;
  [key: string]: unknown;
}

export interface ManagedMetadata {
  schemaVersion: 1;
  packageIdentifier: string;
  requestedVersion?: string;
  installedVersion: string;
  installationType: "npm";
  installationLocation: string;
  installedAt: string;
  lifecycleScriptsEnabled?: boolean;
  servers: ManagedServerAssociation[];
  [key: string]: unknown;
}

export interface ManagedPackageInspection {
  directory: string;
  status: "valid" | "metadata_missing" | "metadata_invalid";
  packageIdentifier?: string;
  installedVersion?: string;
  servers?: ManagedServerAssociation[];
}

export interface ManagedInstallRootOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  mcpgetDataDir?: string;
  localAppData?: string;
  xdgDataHome?: string;
}

export function managedInstallRoot(
  options: ManagedInstallRootOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const mcpgetDataDir = options.mcpgetDataDir ?? env.MCPGET_DATA_DIR;
  const home = options.home ?? homedir();
  const joinPath =
    platform === "win32" ? importPathWin32.join : importPathPosix.join;

  if (mcpgetDataDir) return joinPath(mcpgetDataDir, "installations");
  if (platform === "win32")
    return joinPath(
      options.localAppData ??
        env.LOCALAPPDATA ??
        joinPath(home, "AppData", "Local"),
      "MCPGet",
      "installations",
    );
  return joinPath(
    options.xdgDataHome ??
      env.XDG_DATA_HOME ??
      joinPath(home, ".local", "share"),
    "mcpget",
    "installations",
  );
}
export function managedInstallPath(
  identifier: string,
  requestedVersion?: string,
  root = managedInstallRoot(),
): string {
  return join(resolve(root), managedInstallKey(identifier, requestedVersion));
}

function managedInstallKey(
  identifier: string,
  requestedVersion?: string,
): string {
  const reference = `${identifier}${requestedVersion ? `@${requestedVersion}` : ""}`;
  return createHash("sha256")
    .update(`npm|${reference}`)
    .digest("hex")
    .slice(0, 24);
}

export async function readManagedPackageMetadata(
  directory: string,
): Promise<ManagedMetadata | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(directory, "mcpget-installation.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      "Managed package metadata is malformed; it was left unchanged.",
    );
  }
  if (!(await isRealManagedDirectory(directory)))
    throw new Error(
      "Managed package metadata is invalid because its path is not a real directory.",
    );
  if (
    !isManagedMetadata(value) ||
    value.installationLocation !== resolve(directory) ||
    basename(resolve(directory)) !==
      managedInstallKey(value.packageIdentifier, value.requestedVersion)
  ) {
    throw new Error(
      "Managed package metadata is invalid or unsupported; it was left unchanged.",
    );
  }
  return value;
}

export async function inspectManagedPackages(
  installRoot = managedInstallRoot(),
): Promise<ManagedPackageInspection[]> {
  let entries;
  try {
    entries = await readdir(installRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const packages: ManagedPackageInspection[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = resolve(installRoot, entry.name);
    const metadata = await readManagedPackageMetadata(directory).catch(
      (error: unknown) => {
        if (
          error instanceof Error &&
          /metadata is malformed|metadata is invalid/i.test(error.message)
        ) {
          return null;
        }
        throw error;
      },
    );
    if (metadata === null) {
      packages.push({ directory, status: "metadata_invalid" });
    } else if (!metadata) {
      packages.push({ directory, status: "metadata_missing" });
    } else {
      packages.push({
        directory,
        status: "valid",
        packageIdentifier: metadata.packageIdentifier,
        installedVersion: metadata.installedVersion,
        servers: metadata.servers,
      });
    }
  }
  return packages;
}

export async function findManagedNpm(
  identifier: string,
  requestedVersion?: string,
  installRoot = managedInstallRoot(),
): Promise<ManagedNpmResult | undefined> {
  const directory = managedInstallPath(
    identifier,
    requestedVersion,
    installRoot,
  );
  const metadata = await readManagedPackageMetadata(directory);
  if (!metadata) return undefined;
  if (metadata.packageIdentifier !== identifier)
    throw new Error(
      "Managed package metadata does not match the requested package.",
    );
  let resolvedPackage: { version: string; bin: string };
  try {
    resolvedPackage = await resolveInstalledPackage(directory, identifier);
  } catch {
    throw new Error(
      "Managed package metadata exists, but its installed files are incomplete or invalid.",
    );
  }
  return {
    directory,
    packageIdentifier: identifier,
    installedVersion: resolvedPackage.version,
    command: process.execPath,
    args: [resolvedPackage.bin],
    reused: true,
    lifecycleScriptsEnabled: metadata.lifecycleScriptsEnabled === true,
    documentedRequirements: await readDocumentedRequirements(
      directory,
      identifier,
    ),
  };
}

export async function installManagedNpm(
  identifier: string,
  requestedVersion?: string,
  timeoutMs = 180_000,
  options: ManagedNpmOptions = {},
): Promise<ManagedNpmResult> {
  validateNpmPackageIdentifier(identifier);
  if (
    requestedVersion &&
    !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(requestedVersion)
  ) {
    throw new Error("The npm package version contains unsupported characters.");
  }
  const reference = `${identifier}${requestedVersion ? `@${requestedVersion}` : ""}`;
  const root = options.installRoot ?? managedInstallRoot();
  const directory = managedInstallPath(identifier, requestedVersion, root);
  const metadataPath = join(directory, "mcpget-installation.json");
  return withFileLock(
    directory,
    async () => {
      const existing = await findManagedNpm(identifier, requestedVersion, root);
      if (existing) {
        const requestedLifecyclePolicy = options.allowLifecycleScripts === true;
        if (existing.lifecycleScriptsEnabled !== requestedLifecyclePolicy) {
          throw new Error(
            `Existing managed npm installation was created with package installation scripts ${existing.lifecycleScriptsEnabled ? "allowed" : "not allowed"}. Remove and reinstall it explicitly to change this choice.`,
          );
        }
        return existing;
      }
      await isRealManagedDirectory(directory);
      let existingContents: string[] = [];
      try {
        existingContents = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existingContents.length) {
        throw new Error(
          "Managed package directory contains files but has no valid MCPGet metadata; inspect it before reinstalling.",
        );
      }
      await mkdir(directory, { recursive: true });
      try {
        await (
          options.runInstaller ??
          ((target, ref, timeout) => {
            const [command, args] = npmInvocation(
              target,
              ref,
              options.allowLifecycleScripts === true,
            );
            return runManagedNpmProcess(command, args, timeout, {
              ...(options.signal ? { signal: options.signal } : {}),
            });
          })
        )(directory, reference, timeoutMs);
        const installed = await resolveInstalledPackage(directory, identifier);
        const metadata: ManagedMetadata = {
          schemaVersion: 1,
          packageIdentifier: identifier,
          ...(requestedVersion ? { requestedVersion } : {}),
          installedVersion: installed.version,
          installationType: "npm",
          installationLocation: directory,
          installedAt: new Date().toISOString(),
          servers: [],
          lifecycleScriptsEnabled: options.allowLifecycleScripts === true,
        };
        await writeManagedMetadata(metadataPath, metadata);
        return {
          directory,
          packageIdentifier: identifier,
          installedVersion: installed.version,
          command: process.execPath,
          args: [installed.bin],
          reused: false,
          lifecycleScriptsEnabled: options.allowLifecycleScripts === true,
          documentedRequirements: await readDocumentedRequirements(
            directory,
            identifier,
          ),
        };
      } catch (error) {
        if (!(error instanceof ManagedNpmTerminationError)) {
          try {
            await rm(directory, {
              recursive: true,
              force: true,
              maxRetries: 5,
              retryDelay: 100,
            });
          } catch (cleanupError) {
            throw new Error(
              "Managed npm installation failed and its incomplete directory could not be removed; inspect it before retrying.",
              { cause: cleanupError },
            );
          }
        }
        throw error;
      }
    },
    { timeoutMs: timeoutMs + 30_000 },
  );
}

export async function updateManagedMetadata(
  result: ManagedNpmResult,
  server: {
    serverIdentifier: string;
    serverName: string;
    client: string;
    configurationEntry: string;
    verificationStatus: string;
    lastVerifiedAt?: string;
  },
): Promise<void> {
  await withFileLock(result.directory, async () => {
    const path = join(result.directory, "mcpget-installation.json");
    const metadata = await readManagedPackageMetadata(result.directory);
    if (!metadata)
      throw new Error(
        "Managed package metadata is missing; association was not written.",
      );
    metadata.lifecycleScriptsEnabled = result.lifecycleScriptsEnabled;
    let item = metadata.servers.find(
      (value) => value.serverIdentifier === server.serverIdentifier,
    );
    if (!item) {
      item = {
        serverIdentifier: server.serverIdentifier,
        serverName: server.serverName,
        clients: [],
        configurationEntries: [],
        verificationStatus: server.verificationStatus,
      };
      metadata.servers.push(item);
    }
    if (!item.clients.includes(server.client)) item.clients.push(server.client);
    if (!item.configurationEntries.includes(server.configurationEntry))
      item.configurationEntries.push(server.configurationEntry);
    item.verificationStatus = server.verificationStatus;
    if (server.lastVerifiedAt) item.lastVerifiedAt = server.lastVerifiedAt;
    await writeManagedMetadata(path, metadata);
  });
}

export async function releaseManagedAssociation(
  installationPath: string,
  serverIdentifier: string,
  client: string,
  configurationEntry?: string,
  installRoot = managedInstallRoot(),
  adapters?: Awaited<ReturnType<typeof getClientAdaptersForContext>>,
): Promise<boolean> {
  const relevantAdapters = adapters ?? (await getClientAdaptersForContext());
  const root = resolve(installRoot);
  const target = resolve(installationPath);
  if (target !== root && !target.startsWith(`${root}${sep}`))
    throw new Error(
      "Refusing to remove a path outside MCPGet's managed installation directory.",
    );
  return withFileLock(target, async () => {
    const metadataPath = join(target, "mcpget-installation.json");
    const metadata = await readManagedPackageMetadata(target);
    if (!metadata) return false;
    const item = metadata.servers.find(
      (value) => value.serverIdentifier === serverIdentifier,
    );
    if (!item) return false;
    if (configurationEntry)
      item.configurationEntries = item.configurationEntries.filter(
        (value) => value !== configurationEntry,
      );
    item.clients = item.clients.filter((value) => value !== client);
    if (!item.clients.length && !item.configurationEntries.length)
      metadata.servers = metadata.servers.filter((value) => value !== item);
    if (metadata.servers.length) {
      await writeManagedMetadata(metadataPath, metadata);
      return false;
    }
    if (await hasManagedPackageReference(target, relevantAdapters)) {
      await writeManagedMetadata(metadataPath, metadata);
      return false;
    }
    await rm(target, { recursive: true, force: true });
    return true;
  });
}

export async function detachManagedAssociation(
  installationPath: string,
  serverIdentifier: string,
  client: string,
  configurationEntry: string | undefined,
  installRoot = managedInstallRoot(),
): Promise<boolean> {
  const root = resolve(installRoot);
  const target = resolve(installationPath);
  if (target !== root && !target.startsWith(`${root}${sep}`))
    throw new Error(
      "Refusing to update a path outside MCPGet's managed installation directory.",
    );
  return withFileLock(target, async () => {
    if (!(await isRealManagedDirectory(target))) return false;
    const metadataPath = join(target, "mcpget-installation.json");
    const metadata = await readManagedPackageMetadata(target);
    if (!metadata) return false;
    const item = metadata.servers.find(
      (value) => value.serverIdentifier === serverIdentifier,
    );
    if (!item) return false;
    if (configurationEntry)
      item.configurationEntries = item.configurationEntries.filter(
        (value) => value !== configurationEntry,
      );
    item.clients = item.clients.filter((value) => value !== client);
    if (!item.clients.length && !item.configurationEntries.length)
      metadata.servers = metadata.servers.filter((value) => value !== item);
    await writeManagedMetadata(metadataPath, metadata);
    return true;
  });
}

export async function cleanupOrphanedManagedPackage(
  directory: string,
  installRoot = managedInstallRoot(),
  adapters?: Awaited<ReturnType<typeof getClientAdaptersForContext>>,
): Promise<boolean> {
  const relevantAdapters = adapters ?? (await getClientAdaptersForContext());
  const root = resolve(installRoot);
  const target = resolve(directory);
  if (target !== root && !target.startsWith(`${root}${sep}`))
    throw new Error(
      "Refusing to remove a path outside MCPGet's managed installation directory.",
    );
  return withFileLock(target, async () => {
    if (!(await isRealManagedDirectory(target))) return false;
    const metadata = await readManagedPackageMetadata(target);
    if (!metadata || metadata.servers.length) return false;
    if (await hasManagedPackageReference(target, relevantAdapters))
      return false;
    await rm(target, { recursive: true, force: true });
    return true;
  });
}

export async function hasManagedPackageReference(
  packageDirectory: string,
  adapters?: Awaited<ReturnType<typeof getClientAdaptersForContext>>,
): Promise<boolean> {
  const relevantAdapters = adapters ?? (await getClientAdaptersForContext());
  const root = resolve(packageDirectory);
  for (const adapter of relevantAdapters) {
    let configurationText: string;
    try {
      await access(adapter.configPath());
      configurationText = await readFile(adapter.configPath(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const rawPathForms = [
      root,
      root.replace(/\\/g, "/"),
      root.replace(/\\/g, "\\\\"),
      JSON.stringify(root).slice(1, -1),
    ];
    const comparedConfiguration =
      process.platform === "win32"
        ? configurationText.toLowerCase()
        : configurationText;
    if (
      rawPathForms.some((form) =>
        comparedConfiguration.includes(
          process.platform === "win32" ? form.toLowerCase() : form,
        ),
      )
    )
      return true;
    const entries = await adapter.read();
    for (const entry of Object.values(entries)) {
      const candidates = [entry.command, ...(entry.args ?? [])].filter(
        (value): value is string => typeof value === "string",
      );
      if (
        candidates.some((candidate) => {
          const resolved = resolve(candidate);
          return resolved === root || resolved.startsWith(`${root}${sep}`);
        })
      )
        return true;
    }
  }
  return false;
}

async function isRealManagedDirectory(directory: string): Promise<boolean> {
  try {
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new Error(
        "Managed package metadata is invalid because its path is not a real directory.",
      );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeManagedMetadata(
  path: string,
  metadata: ManagedMetadata,
): Promise<void> {
  if (!isManagedMetadata(metadata))
    throw new Error("Refusing to write invalid managed package metadata.");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await renameWithRetry(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function resolveInstalledPackage(
  directory: string,
  identifier: string,
): Promise<{ version: string; bin: string }> {
  const packageDir = join(directory, "node_modules", ...identifier.split("/"));
  const metadata = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  ) as PackageMetadata;
  if (metadata.name !== identifier || typeof metadata.version !== "string")
    throw new Error(
      "npm completed, but the installed package identity or version could not be verified.",
    );
  let binValue: unknown;
  if (typeof metadata.bin === "string") binValue = metadata.bin;
  else if (
    typeof metadata.bin === "object" &&
    metadata.bin !== null &&
    !Array.isArray(metadata.bin)
  ) {
    const bins = metadata.bin as Record<string, unknown>;
    const preferred = identifier
      .split("/")
      .at(-1)!
      .replace(/^mcp-server-/, "");
    binValue =
      bins[preferred] ??
      (Object.keys(bins).length === 1 ? Object.values(bins)[0] : undefined);
  }
  if (typeof binValue !== "string")
    throw new Error(
      "The installed npm package does not expose an unambiguous executable. Inspect the package documentation before using it.",
    );
  const bin = resolve(packageDir, binValue);
  if (!isAbsolute(bin) || !bin.startsWith(`${resolve(packageDir)}${sep}`))
    throw new Error(
      "The npm package executable points outside its installation directory.",
    );
  await readFile(bin);
  return { version: metadata.version, bin };
}

async function readDocumentedRequirements(
  directory: string,
  identifier: string,
): Promise<RegistryInputRequirement[]> {
  const packageDir = join(directory, "node_modules", ...identifier.split("/"));
  let readme: string;
  try {
    readme = await readFile(join(packageDir, "README.md"), "utf8");
  } catch {
    try {
      readme = await readFile(join(packageDir, "readme.md"), "utf8");
    } catch {
      return [];
    }
  }
  const found = new Map<string, RegistryInputRequirement>();
  for (const line of readme.split(/\r?\n/)) {
    if (
      !/required|must provide|must set|needed/i.test(line) ||
      !/api\s*key|token|credential|secret|environment variable|env var/i.test(
        line,
      )
    )
      continue;
    for (const match of line.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
      found.set(match[0], {
        name: match[0],
        required: true,
        secret: /api\s*key|token|credential|secret|password/i.test(
          `${line} ${match[0]}`,
        ),
        description: line.trim().slice(0, 240),
        deployment: "local-package",
      });
    }
  }
  return [...found.values()].slice(0, 8);
}

export function validateNpmPackageIdentifier(identifier: string): void {
  if (
    !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9][a-z0-9._~-]*$/i.test(identifier) ||
    identifier.startsWith("-") ||
    identifier.startsWith(".")
  ) {
    throw new Error(
      "The npm package identifier is invalid or could be interpreted as an npm option.",
    );
  }
}

export function npmInvocation(
  directory: string,
  packageReference: string,
  allowLifecycleScripts: boolean,
): [string, string[]] {
  const { identifier, version } = parseNpmPackageReference(packageReference);
  validateNpmPackageIdentifier(identifier);
  if (
    version !== undefined &&
    (!version ||
      version.startsWith("-") ||
      /[\s/@\\]/.test(version) ||
      version.includes("\0"))
  ) {
    throw new Error(
      "The npm package reference contains an invalid version or tag.",
    );
  }
  const args = [
    "install",
    "--prefix",
    directory,
    "--no-audit",
    "--no-fund",
    "--package-lock=true",
    allowLifecycleScripts ? "--foreground-scripts" : "--ignore-scripts",
    "--",
    packageReference,
  ];
  if (process.platform !== "win32") return ["npm", args];
  const npmCli = join(
    dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  return [process.execPath, [npmCli, ...args]];
}

function parseNpmPackageReference(packageReference: string): {
  identifier: string;
  version?: string;
} {
  const separator = packageReference.lastIndexOf("@");
  if (packageReference.startsWith("@")) {
    const scopeSeparator = packageReference.indexOf("/");
    if (scopeSeparator < 2) return { identifier: packageReference };
    if (separator > scopeSeparator)
      return {
        identifier: packageReference.slice(0, separator),
        version: packageReference.slice(separator + 1),
      };
    return { identifier: packageReference };
  }
  if (separator > 0) {
    return {
      identifier: packageReference.slice(0, separator),
      version: packageReference.slice(separator + 1),
    };
  }
  return { identifier: packageReference };
}

export interface ManagedNpmProcessOptions {
  signal?: AbortSignal;
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
  terminateTree?: (
    child: ChildProcess,
    gracefulTimeoutMs: number,
    forceTimeoutMs: number,
  ) => Promise<void>;
}

const defaultGracefulTerminationMs = 750;
const defaultForcedTerminationMs = 5_000;

export async function runManagedNpmProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  options: ManagedNpmProcessOptions = {},
): Promise<void> {
  if (options.signal?.aborted) throw new ManagedNpmCancelledError("ABORT");

  const child = spawn(command, args, {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
    detached: process.platform !== "win32",
  });
  const exitPromise = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  const controller = new AbortController();
  let cancellation: ManagedNpmCancelledError | undefined;
  const cancel = (signal: NodeJS.Signals | "ABORT"): void => {
    if (cancellation) return;
    cancellation = new ManagedNpmCancelledError(signal);
    controller.abort();
  };
  const onSigint = (): void => cancel("SIGINT");
  const onSigterm = (): void => cancel("SIGTERM");
  const onAbort = (): void => cancel("ABORT");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timeout"), timeoutMs);
  });
  const cancellationPromise = new Promise<"cancelled">(
    (resolveCancellation) => {
      controller.signal.addEventListener(
        "abort",
        () => resolveCancellation("cancelled"),
        { once: true },
      );
    },
  );
  const terminateTree = options.terminateTree ?? terminateProcessTree;
  try {
    let outcome:
      | { code: number | null; signal: NodeJS.Signals | null }
      | "timeout"
      | "cancelled";
    try {
      outcome = await Promise.race([
        exitPromise,
        timeoutPromise,
        cancellationPromise,
      ]);
    } catch (error) {
      if (child.pid !== undefined)
        await terminateOrFail(
          child,
          terminateTree,
          options.gracefulTimeoutMs,
          options.forceTimeoutMs,
          error,
        );
      throw new Error(
        `Could not start or monitor the npm runtime: ${error instanceof Error ? error.message : "unknown process error"}`,
        { cause: error },
      );
    }

    if (outcome !== "timeout" && outcome !== "cancelled") {
      if (outcome.code === 0) return;
      if (child.pid !== undefined)
        await terminateOrFail(
          child,
          terminateTree,
          options.gracefulTimeoutMs,
          options.forceTimeoutMs,
        );
      throw new Error(
        `Managed npm installation failed with exit code ${outcome.code ?? "unknown"}. Review npm's local diagnostics and retry.`,
      );
    }

    await terminateOrFail(
      child,
      terminateTree,
      options.gracefulTimeoutMs,
      options.forceTimeoutMs,
    );
    if (outcome === "cancelled") throw cancellation;
    throw new Error(
      "Managed npm installation timed out; the incomplete isolated installation was removed.",
    );
  } finally {
    if (timer) clearTimeout(timer);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

type TreeTerminator = NonNullable<ManagedNpmProcessOptions["terminateTree"]>;

async function terminateOrFail(
  child: ChildProcess,
  terminateTree: TreeTerminator,
  gracefulTimeoutMs = defaultGracefulTerminationMs,
  forceTimeoutMs = defaultForcedTerminationMs,
  cause?: unknown,
): Promise<void> {
  if (child.pid === undefined)
    throw new ManagedNpmTerminationError({
      cause: new Error("The npm process did not expose a PID for termination."),
    });
  try {
    await terminateTree(child, gracefulTimeoutMs, forceTimeoutMs);
  } catch (error) {
    throw new ManagedNpmTerminationError({ cause: cause ?? error });
  }
}

async function terminateProcessTree(
  child: ChildProcess,
  gracefulTimeoutMs: number,
  forceTimeoutMs: number,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await terminateWindowsProcessTree(pid, gracefulTimeoutMs, forceTimeoutMs);
    return;
  }

  const processGroupId = -pid;
  try {
    process.kill(processGroupId, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
  }
  if (await waitForProcessGroupExit(processGroupId, gracefulTimeoutMs)) return;

  try {
    process.kill(processGroupId, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (!(await waitForProcessGroupExit(processGroupId, forceTimeoutMs)))
    throw new Error(
      "The npm process group remained active after force termination.",
    );
}

async function terminateWindowsProcessTree(
  pid: number,
  gracefulTimeoutMs: number,
  forceTimeoutMs: number,
): Promise<void> {
  let gracefulSucceeded = false;
  try {
    gracefulSucceeded =
      (await runTaskkill(pid, false, gracefulTimeoutMs)) === 0;
  } catch {
    gracefulSucceeded = false;
  }
  if (gracefulSucceeded && (await waitForProcessExit(pid, gracefulTimeoutMs)))
    return;

  const forceSucceeded = (await runTaskkill(pid, true, forceTimeoutMs)) === 0;
  if (!forceSucceeded || !(await waitForProcessExit(pid, forceTimeoutMs)))
    throw new Error(
      "Windows could not confirm termination of the npm process tree.",
    );
}

async function runTaskkill(
  pid: number,
  force: boolean,
  timeoutMs: number,
): Promise<number> {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const executable = join(systemRoot, "System32", "taskkill.exe");
  const child = spawn(
    executable,
    ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
    { shell: false, windowsHide: true, stdio: "ignore" },
  );
  let closeResolve: (code: number | null) => void = () => undefined;
  let closeReject: (error: Error) => void = () => undefined;
  const closePromise = new Promise<number | null>(
    (resolveClose, rejectClose) => {
      closeResolve = resolveClose;
      closeReject = rejectClose;
    },
  );
  child.once("error", closeReject);
  child.once("close", (code) => closeResolve(code));
  let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      closePromise.then((code) => ({ kind: "closed" as const, code })),
      new Promise<{ kind: "timeout" }>((resolveTimeout) => {
        timer = setTimeout(
          () => resolveTimeout({ kind: "timeout" }),
          timeoutMs,
        );
      }),
    ]);
    if (outcome.kind === "closed") return outcome.code ?? -1;
    child.kill();
    const closed = await Promise.race([
      closePromise.then(() => true),
      delay(Math.min(timeoutMs, 500)).then(() => false),
    ]);
    if (!closed)
      throw new Error(
        "The Windows process-tree termination utility did not exit.",
      );
    throw new Error("The Windows process-tree termination utility timed out.");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let firstAttempt = true;
  while (firstAttempt || Date.now() < deadline) {
    firstAttempt = false;
    try {
      process.kill(processGroupId, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
  return false;
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let firstAttempt = true;
  while (firstAttempt || Date.now() < deadline) {
    firstAttempt = false;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isManagedMetadata(value: unknown): value is ManagedMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const metadata = value as Record<string, unknown>;
  if (
    metadata.schemaVersion !== 1 ||
    typeof metadata.packageIdentifier !== "string" ||
    !isSafeNpmIdentifier(metadata.packageIdentifier) ||
    typeof metadata.installedVersion !== "string" ||
    !isSafeVersion(metadata.installedVersion) ||
    metadata.installationType !== "npm" ||
    typeof metadata.installationLocation !== "string" ||
    typeof metadata.installedAt !== "string" ||
    !Number.isFinite(Date.parse(metadata.installedAt)) ||
    !Array.isArray(metadata.servers) ||
    (metadata.requestedVersion !== undefined &&
      (typeof metadata.requestedVersion !== "string" ||
        !isSafeVersion(metadata.requestedVersion))) ||
    (metadata.lifecycleScriptsEnabled !== undefined &&
      typeof metadata.lifecycleScriptsEnabled !== "boolean")
  )
    return false;
  const serverIdentifiers = new Set<string>();
  return metadata.servers.every((server: unknown) => {
    if (typeof server !== "object" || server === null || Array.isArray(server))
      return false;
    const association = server as Record<string, unknown>;
    const identifier = association.serverIdentifier;
    if (
      typeof identifier !== "string" ||
      identifier.length === 0 ||
      serverIdentifiers.has(identifier)
    )
      return false;
    const valid =
      typeof association.serverName === "string" &&
      Array.isArray(association.clients) &&
      association.clients.every(
        (client: unknown) =>
          client === "claude" ||
          client === "claude-code" ||
          client === "copilot-vscode" ||
          client === "copilot-cli" ||
          client === "codex" ||
          client === "cursor",
      ) &&
      Array.isArray(association.configurationEntries) &&
      association.configurationEntries.every(
        (entry: unknown) => typeof entry === "string" && entry.length > 0,
      ) &&
      typeof association.verificationStatus === "string" &&
      (association.lastVerifiedAt === undefined ||
        (typeof association.lastVerifiedAt === "string" &&
          Number.isFinite(Date.parse(association.lastVerifiedAt))));
    if (!valid) return false;
    serverIdentifiers.add(identifier);
    return true;
  });
}

function isSafeNpmIdentifier(value: string): boolean {
  return /^(?:@[a-z0-9._~-]+\/)?[a-z0-9][a-z0-9._~-]*$/i.test(value);
}

function isSafeVersion(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(value)
  );
}
