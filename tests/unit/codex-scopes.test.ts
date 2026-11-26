import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexTargetCandidates,
  resolveCodexScopeContext,
} from "../../src/installers/codex-scopes.js";

const temporaryDirectories: string[] = [];
const previousCodexHome = process.env.CODEX_HOME;

afterEach(async () => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "mcpget-codex-scopes-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("Codex configuration scope discovery", () => {
  it("uses custom CODEX_HOME while still discovering all trusted project layers", async () => {
    const root = await temporaryDirectory();
    const codexHome = path.join(root, "custom-codex-home");
    const projectRoot = path.join(root, "repo");
    const nested = path.join(projectRoot, "packages", "app");
    await mkdir(path.join(projectRoot, ".git"), { recursive: true });
    await mkdir(path.join(projectRoot, ".codex"), { recursive: true });
    await mkdir(path.join(nested, ".codex"), { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(projectRoot, ".codex", "config.toml"), "");
    await writeFile(path.join(nested, ".codex", "config.toml"), "");
    await writeFile(
      path.join(codexHome, "config.toml"),
      `[projects.${JSON.stringify(projectRoot)}]\ntrust_level = "trusted"\n`,
    );
    process.env.CODEX_HOME = codexHome;

    const context = await resolveCodexScopeContext({ cwd: nested });

    expect(context).toMatchObject({
      userConfigPath: path.join(codexHome, "config.toml"),
      projectRoot,
      projectTrusted: true,
      projectStatus: "available",
      projectConfigPaths: [
        path.join(projectRoot, ".codex", "config.toml"),
        path.join(nested, ".codex", "config.toml"),
      ],
    });
    expect(
      codexTargetCandidates(context, { scope: "project" }).map(
        (target) => target.path,
      ),
    ).toEqual(context.projectConfigPaths);
  });

  it("does not inspect or offer untrusted project configuration for mutation", async () => {
    const root = await temporaryDirectory();
    const codexHome = path.join(root, "codex-home");
    const projectRoot = path.join(root, "repo");
    await mkdir(path.join(projectRoot, ".git"), { recursive: true });
    await mkdir(path.join(projectRoot, ".codex"), { recursive: true });
    await mkdir(codexHome, { recursive: true });
    const projectConfigPath = path.join(projectRoot, ".codex", "config.toml");
    await writeFile(
      projectConfigPath,
      "[mcp_servers.untrusted]\ncommand = 'x'\n",
    );
    await writeFile(
      path.join(codexHome, "config.toml"),
      `[projects.${JSON.stringify(projectRoot)}]\ntrust_level = "untrusted"\n`,
    );

    const context = await resolveCodexScopeContext({
      cwd: projectRoot,
      codexHome,
    });

    expect(context.projectStatus).toBe("untrusted");
    expect(context.projectConfigPaths).toEqual([]);
    expect(() => codexTargetCandidates(context, { scope: "project" })).toThrow(
      /untrusted/i,
    );
  });

  it("selects the root target only when a trusted project has no existing layer", async () => {
    const root = await temporaryDirectory();
    const codexHome = path.join(root, "codex-home");
    const projectRoot = path.join(root, "repo");
    await mkdir(path.join(projectRoot, ".git"), { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      path.join(codexHome, "config.toml"),
      `[projects.${JSON.stringify(projectRoot)}]\ntrust_level = "trusted"\n`,
    );

    const context = await resolveCodexScopeContext({
      cwd: projectRoot,
      codexHome,
    });

    expect(context.projectConfigPaths).toEqual([]);
    expect(codexTargetCandidates(context, { scope: "project" })).toEqual([
      {
        path: path.join(projectRoot, ".codex", "config.toml"),
        scope: "project",
      },
    ]);
  });

  it("adds an explicitly selected profile without changing the user config path", async () => {
    const root = await temporaryDirectory();
    const codexHome = path.join(root, "codex-home");
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "config.toml"), "");

    const context = await resolveCodexScopeContext({
      cwd: root,
      codexHome,
      profile: "review_mode",
    });

    expect(context.userConfigPath).toBe(path.join(codexHome, "config.toml"));
    expect(context.profileConfigPath).toBe(
      path.join(codexHome, "review_mode.config.toml"),
    );
    await expect(
      resolveCodexScopeContext({
        cwd: root,
        codexHome,
        profile: "../outside",
      }),
    ).rejects.toThrow(/profile name is invalid/i);
  });
});
