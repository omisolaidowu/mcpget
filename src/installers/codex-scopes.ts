import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import importPath from "node:path";
import { parse, type TomlTable } from "smol-toml";
import type { ConfigurationScope } from "./types.js";

export interface CodexScopeContext {
  userConfigPath: string;
  profileConfigPath?: string;
  projectRoot?: string;
  projectConfigPaths: string[];
  projectTargetPath?: string;
  projectTrusted: boolean;
  projectStatus: "available" | "untrusted" | "not_found";
}

export interface CodexScopeOptions {
  cwd?: string;
  codexHome?: string;
  platform?: NodeJS.Platform;
  profile?: string;
}

export interface CodexTarget {
  path: string;
  scope: ConfigurationScope;
}

export function codexTargetCandidates(
  context: CodexScopeContext,
  options: {
    scope?: ConfigurationScope;
    configPath?: string;
  } = {},
): CodexTarget[] {
  const platform = process.platform;
  const path = platform === "win32" ? importPath.win32 : importPath.posix;
  const userPath = context.profileConfigPath ?? context.userConfigPath;
  const projectPaths =
    context.projectConfigPaths.length > 0
      ? context.projectConfigPaths
      : context.projectTargetPath
        ? [context.projectTargetPath]
        : [];
  const available: CodexTarget[] = [
    { path: userPath, scope: "user" },
    ...(context.projectTrusted
      ? projectPaths.map((configPath) => ({
          path: configPath,
          scope: "project" as const,
        }))
      : []),
  ];
  if (options.configPath) {
    const configPath = path.resolve(options.configPath);
    const selected = available.find(
      (candidate) =>
        normalizePath(candidate.path, path) === normalizePath(configPath, path),
    );
    if (!selected)
      throw new Error(
        `Codex configuration path is outside the available trusted user/project scopes: ${configPath}.`,
      );
    if (options.scope && options.scope !== selected.scope)
      throw new Error(
        `Configuration ${configPath} belongs to ${selected.scope} scope, not ${options.scope} scope.`,
      );
    return [selected];
  }
  if (options.scope === "project" && !context.projectTrusted)
    throw new Error(
      context.projectStatus === "untrusted"
        ? "The current Codex project is untrusted. Trust it in Codex before selecting project scope."
        : "No Codex project context was found from the current working directory.",
    );
  if (options.scope)
    return available.filter((candidate) => candidate.scope === options.scope);
  return available;
}

export async function resolveCodexScopeContext(
  options: CodexScopeOptions = {},
): Promise<CodexScopeContext> {
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? importPath.win32 : importPath.posix;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const codexHome =
    options.codexHome ??
    (process.env.CODEX_HOME || path.join(homedir(), ".codex"));
  const userConfigPath = path.join(codexHome, "config.toml");
  if (
    options.profile !== undefined &&
    !/^[A-Za-z0-9_-]+$/.test(options.profile)
  )
    throw new Error("Codex profile name is invalid.");
  const userConfig = await readTomlIfPresent(userConfigPath);
  const profileConfigPath = options.profile
    ? path.join(codexHome, `${options.profile}.config.toml`)
    : undefined;
  const markers = readProjectRootMarkers(userConfig, userConfigPath);
  const projectRoot = await findProjectRoot(cwd, markers, path);
  if (!projectRoot) {
    return {
      userConfigPath,
      ...(profileConfigPath ? { profileConfigPath } : {}),
      projectConfigPaths: [],
      projectTrusted: false,
      projectStatus: "not_found",
    };
  }

  const projectTrusted = isTrustedProject(userConfig, projectRoot, path);
  if (!projectTrusted) {
    return {
      userConfigPath,
      ...(profileConfigPath ? { profileConfigPath } : {}),
      projectRoot,
      projectConfigPaths: [],
      projectTargetPath: path.join(projectRoot, ".codex", "config.toml"),
      projectTrusted: false,
      projectStatus: "untrusted",
    };
  }

  const projectConfigPaths = await findProjectConfigPaths(
    projectRoot,
    cwd,
    path,
  );
  return {
    userConfigPath,
    ...(profileConfigPath ? { profileConfigPath } : {}),
    projectRoot,
    projectConfigPaths,
    projectTargetPath: path.join(projectRoot, ".codex", "config.toml"),
    projectTrusted: true,
    projectStatus: "available",
  };
}

async function readTomlIfPresent(path: string): Promise<TomlTable> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (
      ["EACCES", "EPERM", "EISDIR", "ENOTDIR"].includes(
        String((error as NodeJS.ErrnoException).code),
      )
    )
      throw new Error(`Codex user configuration is inaccessible at ${path}.`);
    throw error;
  }
  try {
    return parse(contents, { unsafeKeyBehaviour: "throw" });
  } catch {
    throw new Error(
      `Codex user configuration is malformed TOML at ${path}. Repair the existing configuration or its file permissions, then rerun the command.`,
    );
  }
}

function readProjectRootMarkers(
  config: TomlTable,
  configPath: string,
): string[] {
  const value = config.project_root_markers;
  if (value === undefined) return [".git"];
  if (!Array.isArray(value))
    throw new Error(
      `Codex project_root_markers has an unsupported schema in ${configPath}.`,
    );
  const markers: string[] = [];
  for (const marker of value) {
    if (typeof marker !== "string" || marker.length === 0)
      throw new Error(
        `Codex project_root_markers has an unsupported schema in ${configPath}.`,
      );
    markers.push(marker);
  }
  return markers;
}

async function findProjectRoot(
  cwd: string,
  markers: string[],
  path: typeof import("node:path").posix | typeof import("node:path").win32,
): Promise<string | undefined> {
  let directory = cwd;
  while (true) {
    if (!markers.length && directory === cwd) return cwd;
    for (const marker of markers) {
      try {
        await stat(path.join(directory, marker));
        return directory;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function isTrustedProject(
  config: TomlTable,
  projectRoot: string,
  path: typeof import("node:path").posix | typeof import("node:path").win32,
): boolean {
  const projects = config.projects;
  if (!isTomlTable(projects)) return false;
  const target = normalizePath(projectRoot, path);
  for (const [project, value] of Object.entries(projects)) {
    if (
      normalizePath(project, path) === target &&
      isTomlTable(value) &&
      value.trust_level === "trusted"
    )
      return true;
  }
  return false;
}

async function findProjectConfigPaths(
  projectRoot: string,
  cwd: string,
  path: typeof import("node:path").posix | typeof import("node:path").win32,
): Promise<string[]> {
  const directories: string[] = [];
  let directory = cwd;
  while (true) {
    directories.push(directory);
    if (normalizePath(directory, path) === normalizePath(projectRoot, path))
      break;
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error(
        "Codex project root is not an ancestor of the current directory.",
      );
    directory = parent;
  }
  directories.reverse();
  const result: string[] = [];
  for (const candidate of directories) {
    const configPath = path.join(candidate, ".codex", "config.toml");
    try {
      const info = await stat(configPath);
      if (!info.isFile())
        throw new Error(
          `Codex project configuration is not a file at ${configPath}.`,
        );
      result.push(configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return result;
}

function normalizePath(
  value: string,
  path: typeof import("node:path").posix | typeof import("node:path").win32,
): string {
  const normalized = path.normalize(path.resolve(value));
  return path === importPath.win32 ? normalized.toLowerCase() : normalized;
}

function isTomlTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
