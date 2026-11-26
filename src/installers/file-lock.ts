import { randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

interface LockOwner {
  schemaVersion: 1;
  pid: number;
  hostname: string;
  token: string;
  createdAt: string;
}

interface FileLockOptions {
  timeoutMs?: number;
}

const activeLocks = new AsyncLocalStorage<Set<string>>();
const DEFAULT_TIMEOUT_MS = 10_000;

export async function withFileLock<T>(
  resourcePath: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const resource = resolve(resourcePath);
  const active = activeLocks.getStore();
  if (active?.has(resource)) return operation();

  const lockDirectory = `${resource}.mcpget.lock`;
  const ownerPath = join(lockDirectory, "owner.json");
  const owner: LockOwner = {
    schemaVersion: 1,
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await acquire(
    lockDirectory,
    ownerPath,
    owner,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const held = new Set(active ?? []);
  held.add(resource);
  try {
    return await activeLocks.run(held, operation);
  } finally {
    await release(lockDirectory, ownerPath, owner.token);
  }
}

export async function renameWithRetry(
  source: string,
  destination: string,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") ||
        attempt === 7
      ) {
        throw error;
      }
      await delay(20 * (attempt + 1));
    }
  }
}

async function acquire(
  lockDirectory: string,
  ownerPath: string,
  owner: LockOwner,
  timeoutMs: number,
): Promise<void> {
  await mkdir(dirname(lockDirectory), { recursive: true });
  const stageDirectory = `${lockDirectory}.stage-${owner.token}`;
  await mkdir(stageDirectory);
  try {
    await writeFileExclusive(join(stageDirectory, "owner.json"), owner);
    const deadline = Date.now() + timeoutMs;
    let lastIssue = "another MCPGet process owns the lock";

    for (;;) {
      try {
        await rename(stageDirectory, lockDirectory);
        return;
      } catch (error) {
        if (!(await pathExists(lockDirectory))) {
          const code = (error as NodeJS.ErrnoException).code;
          const retryablePublicationConflict =
            process.platform === "win32"
              ? ["EPERM", "EACCES", "EBUSY"].includes(code ?? "")
              : ["EEXIST", "ENOTEMPTY"].includes(code ?? "");
          if (
            !retryablePublicationConflict ||
            !(await pathExists(stageDirectory))
          )
            throw error;
          lastIssue = "the lock was released while publication was in progress";
        } else {
          const observedOwner = await readOwner(ownerPath);
          if (observedOwner) {
            const state = processState(observedOwner);
            if (state === "dead") {
              const staleDirectory = `${lockDirectory}.stale-${randomUUID()}`;
              try {
                await rename(lockDirectory, staleDirectory);
                const movedOwner = await readOwner(
                  join(staleDirectory, "owner.json"),
                );
                if (movedOwner?.token === observedOwner.token) {
                  await rm(staleDirectory, { recursive: true, force: true });
                  continue;
                }
                try {
                  await rename(staleDirectory, lockDirectory);
                } catch {
                  lastIssue =
                    "a lock changed while stale-lock recovery was in progress";
                }
              } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== "ENOENT")
                  lastIssue =
                    "stale-lock recovery could not safely claim the lock";
              }
            } else if (state === "unknown") {
              lastIssue = "the lock owner cannot be verified on this host";
            }
          } else {
            lastIssue = "the lock owner record is incomplete or unreadable";
          }
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for MCPGet lock for ${lockDirectory}: ${lastIssue}.`,
        );
      }
      await delay(35 + Math.floor(Math.random() * 40));
    }
  } finally {
    await rm(stageDirectory, { recursive: true, force: true });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeFileExclusive(
  path: string,
  owner: LockOwner,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(owner)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function readOwner(path: string): Promise<LockOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      (value as LockOwner).schemaVersion !== 1 ||
      !Number.isSafeInteger((value as LockOwner).pid) ||
      (value as LockOwner).pid <= 0 ||
      typeof (value as LockOwner).hostname !== "string" ||
      typeof (value as LockOwner).token !== "string" ||
      typeof (value as LockOwner).createdAt !== "string"
    ) {
      return undefined;
    }
    return value as LockOwner;
  } catch {
    return undefined;
  }
}

function processState(owner: LockOwner): "live" | "dead" | "unknown" {
  if (owner.hostname !== hostname()) return "unknown";
  try {
    process.kill(owner.pid, 0);
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "live";
    return "unknown";
  }
}

async function release(
  lockDirectory: string,
  ownerPath: string,
  token: string,
): Promise<void> {
  const owner = await readOwner(ownerPath);
  if (owner?.token !== token) {
    throw new Error(
      `MCPGet lock ownership changed unexpectedly for ${lockDirectory}.`,
    );
  }
  const releasedDirectory = `${lockDirectory}.released-${token}`;
  await renameWithRetry(lockDirectory, releasedDirectory);
  await rm(releasedDirectory, { recursive: true, force: true });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
