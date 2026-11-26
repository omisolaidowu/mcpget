import { createJsonClientAdapters } from "./json-client-adapter.js";
import { JsonClientAdapter } from "./json-client-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { ClaudeCodeAdapter } from "./claude-code-adapter.js";
import { resolveClaudeCodeScopeContext } from "./claude-code-scopes.js";
import {
  resolveCopilotScopeContext,
  resolveCopilotUserConfigPath,
} from "./copilot-scopes.js";
import { homedir } from "node:os";
import path from "node:path";
import type { ClientAdapter, ClientId } from "./types.js";
import {
  resolveCodexScopeContext,
  type CodexScopeContext,
} from "./codex-scopes.js";

export function getClientAdapters(): ClientAdapter[] {
  const copilotPath = resolveCopilotConfigPath();
  return [
    ...createJsonClientAdapters(),
    new CodexAdapter(),
    new JsonClientAdapter(
      "copilot-vscode",
      "GitHub Copilot in VS Code",
      copilotPath,
    ),
    new JsonClientAdapter("copilot-cli", "GitHub Copilot CLI", copilotPath),
    new ClaudeCodeAdapter(
      resolveClaudeCodeScopeContextSync().claudeJsonPath,
      "user",
    ),
  ];
}
export function resolveCopilotConfigPath(
  options: {
    home?: string;
    copilotHome?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): string {
  return resolveCopilotUserConfigPath(options);
}
function resolveClaudeCodeScopeContextSync(): { claudeJsonPath: string } {
  const explicit =
    process.env.MCPGET_CLAUDE_CODE_CONFIG_PATH ??
    (process.env.CLAUDE_CONFIG_DIR
      ? path.join(path.resolve(process.env.CLAUDE_CONFIG_DIR), ".claude.json")
      : undefined);
  return {
    claudeJsonPath: explicit
      ? path.resolve(explicit)
      : path.join(homedir(), ".claude.json"),
  };
}
export function getClientAdapter(id: string): ClientAdapter {
  const client = getClientAdapters().find(
    (item) => item.id === id.toLowerCase(),
  );
  if (!client)
    throw new Error(
      `Unsupported client “${id}”. Choose claude, claude-code, copilot-vscode, copilot-cli, codex, or cursor.`,
    );
  return client;
}
export interface CodexAdaptersForContext {
  context: CodexScopeContext;
  userAdapter: CodexAdapter;
  projectAdapters: CodexAdapter[];
  allAdapters: CodexAdapter[];
}
export async function getCodexAdaptersForContext(
  profile?: string,
): Promise<CodexAdaptersForContext> {
  const context = await resolveCodexScopeContext(
    profile === undefined ? {} : { profile },
  );
  const baseAdapter = new CodexAdapter(context.userConfigPath);
  const profileAdapter = context.profileConfigPath
    ? new CodexAdapter(context.profileConfigPath)
    : undefined;
  const userAdapter = profileAdapter ?? baseAdapter;
  const projectAdapters = context.projectConfigPaths.map(
    (configPath) =>
      new CodexAdapter(configPath, undefined, undefined, "project"),
  );
  return {
    context,
    userAdapter,
    projectAdapters,
    allAdapters: [
      baseAdapter,
      ...(profileAdapter ? [profileAdapter] : []),
      ...projectAdapters,
    ],
  };
}
export async function getClientAdaptersForContext(
  codexProfile?: string,
): Promise<ClientAdapter[]> {
  const { allAdapters } = await getCodexAdaptersForContext(codexProfile);
  const copilotContext = await resolveCopilotScopeContext();
  const copilotPath = copilotContext.userConfigPath;
  const copilotAdapters: ClientAdapter[] = [
    new JsonClientAdapter(
      "copilot-vscode",
      "GitHub Copilot in VS Code",
      copilotPath,
    ),
    new JsonClientAdapter("copilot-cli", "GitHub Copilot CLI", copilotPath),
    ...copilotContext.targets
      .filter((target) => target.scope === "project")
      .map(
        (target) =>
          new JsonClientAdapter(
            target.id,
            target.id === "copilot-vscode"
              ? "GitHub Copilot in VS Code"
              : "GitHub Copilot CLI",
            target.configPath,
            undefined,
            "project",
            target.format,
          ),
      ),
  ];
  const claudeCodeContext = await resolveClaudeCodeScopeContext();
  const claudeCodeAdapters = claudeCodeContext.targets
    .filter((target) => target.scope !== "project" || target.trusted)
    .map(
      (target) =>
        new ClaudeCodeAdapter(
          claudeCodeContext.claudeJsonPath,
          target.scope,
          target.projectRoot,
        ),
    );
  return [
    ...createJsonClientAdapters(),
    ...copilotAdapters,
    ...claudeCodeAdapters,
    ...allAdapters,
  ];
}
export function isClientId(value: string): value is ClientId {
  return [
    "claude",
    "claude-code",
    "copilot-vscode",
    "copilot-cli",
    "codex",
    "cursor",
  ].includes(value.toLowerCase());
}
