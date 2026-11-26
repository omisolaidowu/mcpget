import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installManagedNpm,
  ManagedNpmCancelledError,
  ManagedNpmTerminationError,
  runManagedNpmProcess,
} from "../../src/installers/managed-npm.js";

const node = process.execPath;
const shortTermination = {
  gracefulTimeoutMs: 120,
  forceTimeoutMs: 2_000,
};

describe("managed npm process lifecycle", () => {
  it("terminates a direct process after timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcpget-npm-timeout-"));
    const pidFile = join(directory, "parent.pid");
    let pid: number | undefined;
    try {
      const run = runManagedNpmProcess(
        node,
        ["-e", pidScript(pidFile)],
        80,
        shortTermination,
      );
      pid = await readPid(pidFile);
      await expect(run).rejects.toThrow(/installation timed out/i);
      expect(await waitForPidExit(pid)).toBe(true);
    } finally {
      if (pid) await forceCleanup(pid);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("terminates spawned child processes with the timed-out npm process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcpget-npm-tree-"));
    const parentFile = join(directory, "parent.pid");
    const childFile = join(directory, "child.pid");
    let parentPid: number | undefined;
    let childPid: number | undefined;
    try {
      const run = runManagedNpmProcess(
        node,
        ["-e", spawnedChildScript(parentFile, childFile)],
        120,
        shortTermination,
      );
      parentPid = await readPid(parentFile);
      childPid = await readPid(childFile);
      await expect(run).rejects.toThrow(/installation timed out/i);
      expect(await waitForPidExit(parentPid)).toBe(true);
      expect(await waitForPidExit(childPid)).toBe(true);
    } finally {
      if (parentPid) await forceCleanup(parentPid);
      if (childPid) await forceCleanup(childPid);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("terminates descendants left behind when npm exits with a failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcpget-npm-failed-tree-"));
    const parentFile = join(directory, "parent.pid");
    const childFile = join(directory, "child.pid");
    let parentPid: number | undefined;
    let childPid: number | undefined;
    try {
      const script = spawnedChildScript(
        parentFile,
        childFile,
        "",
        "setTimeout(()=>process.exit(1),100);",
      );
      const run = runManagedNpmProcess(
        node,
        ["-e", script],
        2_000,
        shortTermination,
      );
      parentPid = await readPid(parentFile);
      childPid = await readPid(childFile);
      if (process.platform === "win32") {
        await expect(run).rejects.toBeInstanceOf(ManagedNpmTerminationError);
      } else {
        await expect(run).rejects.toThrow(/failed with exit code 1/i);
      }
      expect(await waitForPidExit(parentPid)).toBe(true);
      if (process.platform !== "win32")
        expect(await waitForPidExit(childPid)).toBe(true);
    } finally {
      if (parentPid) await forceCleanup(parentPid);
      if (childPid) await forceCleanup(childPid);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows graceful termination before escalating to force", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "mcpget-npm-graceful-"));
    const pidFile = join(directory, "parent.pid");
    const markerFile = join(directory, "sigterm");
    let pid: number | undefined;
    try {
      const script = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on("SIGTERM",()=>fs.writeFileSync(${JSON.stringify(markerFile)},"received"));setInterval(()=>{},1000);`;
      const run = runManagedNpmProcess(
        node,
        ["-e", script],
        80,
        shortTermination,
      );
      pid = await readPid(pidFile);
      await expect(run).rejects.toThrow(/installation timed out/i);
      expect(await readFile(markerFile, "utf8")).toBe("received");
      expect(await waitForPidExit(pid)).toBe(true);
    } finally {
      if (pid) await forceCleanup(pid);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("force-terminates descendants that refuse graceful termination", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "mcpget-npm-force-"));
    const parentFile = join(directory, "parent.pid");
    const childFile = join(directory, "child.pid");
    let parentPid: number | undefined;
    let childPid: number | undefined;
    try {
      const script = spawnedChildScript(
        parentFile,
        childFile,
        "process.on('SIGTERM',()=>{});",
      );
      const run = runManagedNpmProcess(
        node,
        ["-e", script],
        80,
        shortTermination,
      );
      parentPid = await readPid(parentFile);
      childPid = await readPid(childFile);
      await expect(run).rejects.toThrow(/installation timed out/i);
      expect(await waitForPidExit(parentPid)).toBe(true);
      expect(await waitForPidExit(childPid)).toBe(true);
    } finally {
      if (parentPid) await forceCleanup(parentPid);
      if (childPid) await forceCleanup(childPid);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("terminates the process tree when the caller cancels", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcpget-npm-cancel-"));
    const parentFile = join(directory, "parent.pid");
    const childFile = join(directory, "child.pid");
    const controller = new AbortController();
    let parentPid: number | undefined;
    let childPid: number | undefined;
    try {
      const run = runManagedNpmProcess(
        node,
        ["-e", spawnedChildScript(parentFile, childFile)],
        10_000,
        { ...shortTermination, signal: controller.signal },
      );
      parentPid = await readPid(parentFile);
      childPid = await readPid(childFile);
      controller.abort();
      await expect(run).rejects.toBeInstanceOf(ManagedNpmCancelledError);
      expect(await waitForPidExit(parentPid)).toBe(true);
      expect(await waitForPidExit(childPid)).toBe(true);
    } finally {
      if (parentPid) await forceCleanup(parentPid);
      if (childPid) await forceCleanup(childPid);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when tree termination cannot be confirmed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcpget-npm-unconfirmed-"));
    const pidFile = join(directory, "parent.pid");
    let pid: number | undefined;
    try {
      const run = runManagedNpmProcess(
        node,
        [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>process.exit(0),350);`,
        ],
        50,
        {
          ...shortTermination,
          terminateTree: async () => {
            throw new Error("controlled termination failure");
          },
        },
      );
      const runAssertion = expect(run).rejects.toBeInstanceOf(
        ManagedNpmTerminationError,
      );
      pid = await readPid(pidFile);
      await runAssertion;
      expect(await waitForPidExit(pid, 2_000)).toBe(true);
    } finally {
      if (pid) await forceCleanup(pid);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports process startup errors without leaving a child", async () => {
    await expect(
      runManagedNpmProcess(
        join(tmpdir(), "mcpget-missing-executable"),
        [],
        1_000,
        shortTermination,
      ),
    ).rejects.toThrow(/could not start or monitor/i);
  });

  it("preserves the incomplete directory when termination is unconfirmed", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcpget-npm-preserve-"));
    try {
      await expect(
        installManagedNpm("@example/termination-failure", "1.0.0", 100, {
          installRoot: root,
          runInstaller: async (directory) => {
            await writeFile(join(directory, "partial.txt"), "preserve");
            throw new ManagedNpmTerminationError();
          },
        }),
      ).rejects.toBeInstanceOf(ManagedNpmTerminationError);
      const [directory] = await readdir(root);
      expect(directory).toBeDefined();
      await expect(
        readFile(join(root, directory!, "partial.txt"), "utf8"),
      ).resolves.toBe("preserve");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses Windows tree termination when running on Windows", async () => {
    if (process.platform !== "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "mcpget-npm-windows-tree-"));
    const parentFile = join(directory, "parent.pid");
    const childFile = join(directory, "child.pid");
    let parentPid: number | undefined;
    let childPid: number | undefined;
    try {
      const run = runManagedNpmProcess(
        node,
        ["-e", spawnedChildScript(parentFile, childFile)],
        120,
        shortTermination,
      );
      parentPid = await readPid(parentFile);
      childPid = await readPid(childFile);
      await expect(run).rejects.toThrow(/installation timed out/i);
      expect(await waitForPidExit(parentPid)).toBe(true);
      expect(await waitForPidExit(childPid)).toBe(true);
    } finally {
      if (parentPid) await forceCleanup(parentPid);
      if (childPid) await forceCleanup(childPid);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function pidScript(pidFile: string): string {
  return `require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
}

function spawnedChildScript(
  parentPidFile: string,
  childPidFile: string,
  parentSetup = "",
  parentTail = "setInterval(()=>{},1000);",
): string {
  const childScript = `require("node:fs").writeFileSync(${JSON.stringify(childPidFile)},String(process.pid));setInterval(()=>{},1000);`;
  return `const {spawn}=require("node:child_process");const fs=require("node:fs");${parentSetup}const child=spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:"ignore"});child.unref();fs.writeFileSync(${JSON.stringify(parentPidFile)},String(process.pid));${parentTail}`;
}

async function readPid(path: string, timeoutMs = 2_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(path, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {
      // Wait until the controlled child publishes its PID.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Controlled process did not publish its PID.");
}

async function waitForPidExit(
  pid: number,
  timeoutMs = 2_000,
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return false;
}

async function forceCleanup(pid: number): Promise<void> {
  if (process.platform === "win32") {
    spawnSync(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      { shell: false, windowsHide: true, stdio: "ignore", timeout: 3_000 },
    );
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return;
    }
  }
}
