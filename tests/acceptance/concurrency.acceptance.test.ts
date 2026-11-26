import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  installManagedNpm,
  managedInstallPath,
  updateManagedMetadata,
} from "../../src/installers/managed-npm.js";
import { InstallationStateStore } from "../../src/installers/state-store.js";
import { OperationJournal } from "../../src/installers/operation-journal.js";
import { createInstallationRecord } from "../../src/models/installation.js";

const root = process.cwd();
const cli = join(root, "dist", "cli", "index.js");
const preload = pathToFileURL(
  join(root, "tests", "fixtures", "acceptance-fetch.mjs"),
).href;
const worker = join(root, "tests", "fixtures", "concurrency-worker.mjs");
const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempRoots.map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function environment() {
  const home = await mkdtemp(join(tmpdir(), "mcpget-concurrency-home-"));
  const codexHome = join(home, ".codex");
  await mkdir(codexHome, { recursive: true });
  tempRoots.push(home);
  return {
    home,
    codexHome,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: join(home, ".config"),
      CODEX_HOME: codexHome,
      MCPGET_DATA_DIR: join(home, ".mcpget-data"),
      MCPGET_ACCEPTANCE_MODE: "primary",
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`.trim(),
    },
  };
}

interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return runProcess(process.execPath, ["--import", preload, cli, ...args], env);
}

function runWorker(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return runProcess(process.execPath, [worker, ...args], env);
}

function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Process timed out: ${command} ${args.join(" ")}`));
    }, 60_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function startHoldingWorker(
  resource: string,
  env: NodeJS.ProcessEnv,
  marker = "LOCK_ACQUIRED",
): Promise<ChildProcess> {
  const child = spawn(process.execPath, [worker, "hold", resource], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Lock worker did not start.")),
      10_000,
    );
    child.stdout?.setEncoding("utf8").on(
      "data",
      (chunk: string) => {
        output += chunk;
        if (output.includes(marker)) {
          clearTimeout(timer);
          resolve();
        }
      },
      20_000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      reject(
        new Error(`Lock worker exited before acquiring the lock: ${status}`),
      );
    });
  });
  return child;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

function parseOutput(result: ProcessResult): unknown {
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

async function installRemote(
  candidate: string,
  client: "codex" | "cursor",
  env: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return runCli(
    [
      "install",
      candidate,
      client,
      "--candidate",
      candidate,
      "--source",
      "remote",
      "--yes",
      "--json",
    ],
    env,
  );
}

describe("MCPGet cross-process state coordination", () => {
  it.each([
    ["codex", "Codex TOML"],
    ["cursor", "JSON client configuration"],
  ] as const)(
    "serializes concurrent installs and removals for the same %s configuration",
    async (client) => {
      const { home, codexHome, env } = await environment();
      if (client === "codex") {
        await writeFile(
          join(codexHome, "config.toml"),
          'model = "preserve"\n\n[mcp_servers.unrelated]\nurl = "https://keep.example.test/mcp"\n',
        );
      } else {
        await mkdir(join(home, ".cursor"), { recursive: true });
        await writeFile(
          join(home, ".cursor", "mcp.json"),
          JSON.stringify({
            theme: "preserve",
            mcpServers: {
              unrelated: { command: process.execPath, args: ["keep.js"] },
            },
          }),
        );
      }
      const candidates = ["com.notion/acceptance-test", "com.notion/second"];
      const installs = await Promise.all(
        candidates.map((candidate) => installRemote(candidate, client, env)),
      );
      for (const result of installs) {
        expect(result.status, JSON.stringify(result)).toBe(0);
        expect(parseOutput(result)).toMatchObject({
          schemaVersion: 1,
          ok: true,
          command: "install",
        });
      }

      const configPath =
        client === "codex"
          ? join(codexHome, "config.toml")
          : join(home, ".cursor", "mcp.json");
      const initialText = await readFile(configPath, "utf8");
      expect(initialText).toContain("unrelated");
      const state = JSON.parse(
        await readFile(join(home, ".mcpget", "installations.json"), "utf8"),
      ) as { installations: Array<{ configName: string; client: string }> };
      const names = state.installations
        .filter((record) => record.client === client)
        .map((record) => record.configName);
      expect(names).toHaveLength(2);

      const removals = await Promise.all(
        names.map((name) =>
          runCli(["remove", name, client, "--yes", "--json"], env),
        ),
      );
      for (const result of removals) {
        expect(result.status).toBe(0);
        expect(parseOutput(result)).toMatchObject({
          schemaVersion: 1,
          ok: true,
          command: "remove",
        });
      }
      const finalText = await readFile(configPath, "utf8");
      expect(finalText).toContain("unrelated");
      expect(finalText).not.toContain("acceptance-test-mcp");
      expect(finalText).not.toContain("second-mcp");
      if (client === "cursor") {
        expect(JSON.parse(finalText)).toMatchObject({ theme: "preserve" });
      } else {
        expect(finalText).toContain('model = "preserve"');
      }
    },
    20_000,
  );

  it("serializes concurrent installation and removal of the same server", async () => {
    const { env } = await environment();
    const initial = await installRemote(
      "com.notion/acceptance-test",
      "codex",
      env,
    );
    expect(initial.status).toBe(0);
    const configName = "notion-acceptance-test-mcp";
    const results = await Promise.all([
      installRemote("com.notion/acceptance-test", "codex", env),
      runCli(["remove", configName, "codex", "--yes", "--json"], env),
    ]);
    expect(
      results.every((result) => result.status === 0),
      JSON.stringify(results),
    ).toBe(true);
    const config = await readFile(join(env.CODEX_HOME!, "config.toml"), "utf8");
    const state = JSON.parse(
      await readFile(
        join(env.USERPROFILE!, ".mcpget", "installations.json"),
        "utf8",
      ),
    ) as { installations: Array<{ configName: string }> };
    const configured = config.includes(configName);
    const recorded = state.installations.some(
      (item) => item.configName === configName,
    );
    expect(recorded, `${config}\n${JSON.stringify(state)}`).toBe(configured);
  });

  it("fails closed on a locked configuration, then recovers after its owner exits", async () => {
    const { codexHome, env } = await environment();
    const configPath = join(codexHome, "config.toml");
    await writeFile(configPath, 'model = "keep"\n');
    const holder = await startHoldingWorker(configPath, env);
    try {
      const blocked = await runCli(
        [
          "install",
          "com.notion/acceptance-test",
          "codex",
          "--candidate",
          "com.notion/acceptance-test",
          "--source",
          "remote",
          "--yes",
          "--json",
        ],
        env,
      );
      expect(blocked.status, `${blocked.stdout}\n${blocked.stderr}`).toBe(1);
      const blockedPayload = parseOutput(blocked) as {
        error: { message: string };
      };
      expect(blockedPayload).toMatchObject({
        schemaVersion: 1,
        ok: false,
        command: "install",
        error: { code: "OPERATIONAL_FAILURE" },
      });
      expect(blockedPayload.error.message).toContain(
        "Timed out waiting for MCPGet lock",
      );
    } finally {
      await stopChild(holder);
    }

    const recovered = await Promise.all([
      installRemote("com.notion/acceptance-test", "codex", env),
      installRemote("com.notion/second", "codex", env),
    ]);
    expect(recovered.map((result) => result.status)).toEqual([0, 0]);
    for (const result of recovered)
      expect(parseOutput(result)).toMatchObject({
        ok: true,
        command: "install",
      });
    const recoveredConfig = await readFile(configPath, "utf8");
    expect(recoveredConfig).toContain("notion-acceptance-test-mcp");
    expect(recoveredConfig).toContain("second-mcp");
  }, 20_000);

  it("reconciles an interrupted install concurrently through the built CLI", async () => {
    const { home, codexHome, env } = await environment();
    const configPath = join(codexHome, "config.toml");
    await writeFile(
      configPath,
      '[mcp_servers.recovery_sample]\ncommand = "node"\nargs = ["server.js"]\n',
    );
    const store = new InstallationStateStore(
      join(home, ".mcpget", "installations.json"),
    );
    const record = createInstallationRecord({
      id: "recovery-sample",
      serverIdentifier: "recovery-sample",
      displayName: "Recovery Sample",
      client: "codex",
      source: "acceptance-test",
      strategy: "ephemeral",
      configName: "recovery_sample",
      configPath,
      configScope: "user",
    });
    await store.put(record);
    const journal = new OperationJournal(join(home, ".mcpget", "operations"));
    await journal.begin({
      kind: "install",
      client: "codex",
      configPath,
      configName: "recovery_sample",
      serverIdentifier: "recovery-sample",
    });

    const results = await Promise.all([
      runCli(["recover", "--yes", "--json"], env),
      runCli(["recover", "--yes", "--json"], env),
    ]);
    for (const result of results) {
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(parseOutput(result)).toMatchObject({
        schemaVersion: 1,
        ok: true,
        command: "recover",
      });
    }

    const recovered = await store.get("recovery-sample", "codex");
    expect(recovered?.states.configured.status).toBe("completed");
    expect(recovered?.states.connection_verified.status).toBe("not_verified");
    expect(await journal.list()).toEqual([]);
    expect(await readFile(configPath, "utf8")).toContain("recovery_sample");
  }, 20_000);
});

describe("managed package state coordination", () => {
  async function createManagedPackage(home: string) {
    const installRoot = join(home, ".mcpget-data", "installations");
    const packagePath = managedInstallPath(
      "@example/concurrency-mcp",
      "1.0.0",
      installRoot,
    );
    const result = await installManagedNpm(
      "@example/concurrency-mcp",
      "1.0.0",
      10_000,
      {
        installRoot,
        runInstaller: async (directory) => {
          const packageDirectory = join(
            directory,
            "node_modules",
            "@example",
            "concurrency-mcp",
          );
          await mkdir(join(packageDirectory, "dist"), { recursive: true });
          await writeFile(
            join(packageDirectory, "package.json"),
            JSON.stringify({
              name: "@example/concurrency-mcp",
              version: "1.0.0",
              bin: "dist/cli.js",
            }),
          );
          await writeFile(
            join(packageDirectory, "dist", "cli.js"),
            "process.exit(0)",
          );
        },
      },
    );
    return { installRoot, packagePath, result };
  }

  it("keeps concurrent package associations and reference-counted removals consistent", async () => {
    const { home, env } = await environment();
    const { packagePath, result } = await createManagedPackage(home);
    const association = {
      serverIdentifier: "com.example/server-a",
      serverName: "server-a",
      verificationStatus: "pending",
    };
    await updateManagedMetadata(result, {
      ...association,
      client: "codex",
      configurationEntry: "server-a",
    });
    const addResults = await Promise.all([
      runWorker(
        [
          "metadata-add",
          packagePath,
          "com.example/server-b",
          "cursor",
          "server-b",
        ],
        env,
      ),
      runWorker(
        [
          "metadata-add",
          packagePath,
          "com.example/server-c",
          "claude",
          "server-c",
        ],
        env,
      ),
    ]);
    expect(
      addResults.map((item) => item.status),
      JSON.stringify(addResults),
    ).toEqual([0, 0]);
    const metadata = JSON.parse(
      await readFile(join(packagePath, "mcpget-installation.json"), "utf8"),
    ) as { servers: Array<{ serverIdentifier: string }> };
    expect(
      metadata.servers.map((item) => item.serverIdentifier).sort(),
    ).toEqual([
      "com.example/server-a",
      "com.example/server-b",
      "com.example/server-c",
    ]);

    const oneRemoval = await runWorker(
      [
        "metadata-remove",
        packagePath,
        "com.example/server-b",
        "cursor",
        "server-b",
      ],
      env,
    );
    expect(oneRemoval.stdout.trim()).toBe("false");
    await Promise.all([
      runWorker(
        [
          "metadata-remove",
          packagePath,
          "com.example/server-a",
          "codex",
          "server-a",
        ],
        env,
      ),
      runWorker(
        [
          "metadata-remove",
          packagePath,
          "com.example/server-c",
          "claude",
          "server-c",
        ],
        env,
      ),
    ]);
    await expect(
      readFile(join(packagePath, "mcpget-installation.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("recovers a metadata lock after interruption and a package lock after cleanup interruption", async () => {
    const { home, env } = await environment();
    const { packagePath, installRoot } = await createManagedPackage(home);
    const owner = spawn(
      process.execPath,
      [worker, "metadata-interrupt", packagePath],
      {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let lockOutput = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Metadata lock worker timed out.")),
        10_000,
      );
      owner.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        lockOutput += chunk;
        if (lockOutput.includes("METADATA_LOCK_ACQUIRED")) {
          clearTimeout(timer);
          resolve();
        }
      });
      owner.once("error", reject);
    });
    await stopChild(owner);
    const updated = await runWorker(
      [
        "metadata-add",
        packagePath,
        "com.example/recovered",
        "codex",
        "recovered",
      ],
      env,
    );
    expect(updated.status).toBe(0);
    const metadata = JSON.parse(
      await readFile(join(packagePath, "mcpget-installation.json"), "utf8"),
    ) as { servers: Array<{ serverIdentifier: string }> };
    expect(metadata.servers.map((item) => item.serverIdentifier)).toContain(
      "com.example/recovered",
    );

    const cleaner = spawn(
      process.execPath,
      [worker, "cleanup-interrupt", packagePath],
      {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Cleanup worker timed out.")),
        10_000,
      );
      cleaner.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        if (chunk.includes("PACKAGE_REMOVED")) {
          clearTimeout(timer);
          resolve();
        }
      });
      cleaner.once("error", reject);
    });
    await stopChild(cleaner);
    const installed = await runWorker(
      ["install", installRoot, "@example/concurrency-mcp", "1.0.0"],
      env,
    );
    expect(installed.status).toBe(0);
    expect(installed.stdout).toContain("INSTALL_COMPLETE");
    expect(
      await readFile(join(packagePath, "mcpget-installation.json"), "utf8"),
    ).toContain('"packageIdentifier": "@example/concurrency-mcp"');
  });

  it("serializes managed installation against removal of the same package", async () => {
    const { home, env } = await environment();
    const { packagePath, result, installRoot } =
      await createManagedPackage(home);
    await updateManagedMetadata(result, {
      serverIdentifier: "com.example/server",
      serverName: "server",
      client: "codex",
      configurationEntry: "server",
      verificationStatus: "completed",
    });
    const outcomes = await Promise.all([
      runWorker(
        ["install", installRoot, "@example/concurrency-mcp", "1.0.0", "250"],
        env,
      ),
      runWorker(
        [
          "metadata-remove",
          packagePath,
          "com.example/server",
          "codex",
          "server",
        ],
        env,
      ),
    ]);
    expect(outcomes.every((item) => item.status === 0)).toBe(true);
    try {
      const metadata = JSON.parse(
        await readFile(join(packagePath, "mcpget-installation.json"), "utf8"),
      ) as { servers: unknown[] };
      expect(metadata.servers).toHaveLength(0);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });
});
