import { homedir } from "node:os";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { ConfigurationScope } from "./types.js";

export interface ClaudeCodeScopeTarget {
  scope: ConfigurationScope;
  configPath: string;
  projectRoot?: string;
  trusted: boolean;
}

export interface ClaudeCodeScopeContext {
  claudeJsonPath: string;
  projectRoot?: string;
  targets: ClaudeCodeScopeTarget[];
  projectStatus: "trusted" | "untrusted" | "not_found";
}

export function resolveClaudeCodeConfigDir(
  options: {
    home?: string;
    claudeConfigDir?: string;
    claudeJsonPath?: string;
  } = {},
): string {
  if (options.claudeJsonPath) return path.resolve(options.claudeJsonPath);
  if (process.env.MCPGET_CLAUDE_CODE_CONFIG_PATH)
    return path.resolve(process.env.MCPGET_CLAUDE_CODE_CONFIG_PATH);
  if (options.claudeConfigDir) {
    return path.join(path.resolve(options.claudeConfigDir), ".claude.json");
  }
  if (process.env.CLAUDE_CONFIG_DIR) {
    return path.join(
      path.resolve(process.env.CLAUDE_CONFIG_DIR),
      ".claude.json",
    );
  }
  return path.join(options.home ?? homedir(), ".claude.json");
}

export async function findProjectRoot(
  cwd = process.cwd(),
): Promise<string | undefined> {
  let current = path.resolve(cwd);
  for (;;) {
    try {
      await stat(path.join(current, ".git"));
      return current;
    } catch {
      // Continue walking to the parent directory.
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function resolveClaudeCodeScopeContext(
  options: {
    cwd?: string;
    claudeJsonPath?: string;
    claudeConfigDir?: string;
  } = {},
): Promise<ClaudeCodeScopeContext> {
  const claudeJsonPath = resolveClaudeCodeConfigDir(options);
  const projectRoot = await findProjectRoot(options.cwd);
  const targets: ClaudeCodeScopeTarget[] = [
    { scope: "user", configPath: claudeJsonPath, trusted: true },
  ];
  if (projectRoot) {
    targets.push({
      scope: "local",
      configPath: claudeJsonPath,
      projectRoot,
      trusted: true,
    });
  }

  let trustAccepted = false;
  try {
    const root = JSON.parse(await readFile(claudeJsonPath, "utf8")) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    if (projectRoot) {
      trustAccepted =
        root.projects?.[projectRoot]?.hasTrustDialogAccepted === true;
    }
  } catch {
    trustAccepted = false;
  }
  if (projectRoot) {
    targets.push({
      scope: "project",
      configPath: path.join(projectRoot, ".mcp.json"),
      projectRoot,
      trusted: trustAccepted,
    });
  }
  return {
    claudeJsonPath,
    ...(projectRoot ? { projectRoot } : {}),
    targets,
    projectStatus: projectRoot
      ? trustAccepted
        ? "trusted"
        : "untrusted"
      : "not_found",
  };
}
