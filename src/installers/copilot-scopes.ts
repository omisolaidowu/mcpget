import path from "node:path";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { ConfigurationScope } from "./types.js";

export interface CopilotScopeTarget {
  id: "copilot-vscode" | "copilot-cli";
  scope: ConfigurationScope;
  configPath: string;
  projectRoot?: string;
  format: "mcpServers" | "bare" | "auto";
}

export interface CopilotScopeContext {
  userConfigPath: string;
  projectRoot?: string;
  targets: CopilotScopeTarget[];
}

export function resolveCopilotUserConfigPath(
  options: {
    home?: string;
    copilotHome?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): string {
  const platform = options.platform ?? process.platform;
  const joinPath = platform === "win32" ? path.win32.join : path.posix.join;
  const resolvePath =
    platform === "win32" ? path.win32.resolve : path.posix.resolve;
  const env = options.env ?? process.env;
  const explicit =
    options.copilotHome ??
    env.MCPGET_COPILOT_CONFIG_PATH ??
    (!options.home ? env.COPILOT_HOME : undefined);
  if (explicit) {
    if (
      explicit === env.MCPGET_COPILOT_CONFIG_PATH &&
      env.MCPGET_COPILOT_CONFIG_PATH
    )
      return resolvePath(explicit);
    return joinPath(resolvePath(explicit), "mcp-config.json");
  }
  return joinPath(options.home ?? homedir(), ".copilot", "mcp-config.json");
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
      // Continue toward the filesystem root.
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function resolveCopilotScopeContext(
  options: {
    cwd?: string;
    userConfigPath?: string;
    copilotHome?: string;
  } = {},
): Promise<CopilotScopeContext> {
  const userConfigPath =
    options.userConfigPath ??
    resolveCopilotUserConfigPath({
      ...(options.copilotHome ? { copilotHome: options.copilotHome } : {}),
    });
  const targets: CopilotScopeTarget[] = [
    {
      id: "copilot-vscode",
      scope: "user",
      configPath: userConfigPath,
      format: "mcpServers",
    },
    {
      id: "copilot-cli",
      scope: "user",
      configPath: userConfigPath,
      format: "mcpServers",
    },
  ];
  const projectRoot = await findProjectRoot(options.cwd);
  if (projectRoot) {
    targets.push({
      id: "copilot-vscode",
      scope: "project",
      configPath: path.join(projectRoot, ".mcp.json"),
      projectRoot,
      format: "mcpServers",
    });
    targets.push({
      id: "copilot-cli",
      scope: "project",
      configPath: path.join(projectRoot, ".mcp.json"),
      projectRoot,
      format: "auto",
    });
    targets.push({
      id: "copilot-cli",
      scope: "project",
      configPath: path.join(projectRoot, ".github", "mcp.json"),
      projectRoot,
      format: "auto",
    });
  }
  return {
    userConfigPath,
    ...(projectRoot ? { projectRoot } : {}),
    targets,
  };
}
