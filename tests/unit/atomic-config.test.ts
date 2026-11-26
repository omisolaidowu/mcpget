import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/installers/config-backup.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/installers/config-backup.js")
    >();
  return {
    ...actual,
    createConfigBackup: vi.fn(async () => {
      throw new Error("Synthetic backup creation failure.");
    }),
  };
});

import { writeJsonSafely } from "../../src/installers/atomic-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("atomic JSON configuration backups", () => {
  it("does not modify the active config when backup creation fails", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "mcpget-backup-create-failure-"),
    );
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "client.json");
    const original =
      '{"theme":"keep","mcpServers":{"sample":{"command":"node"}}}\n';
    await writeFile(configPath, original);

    await expect(
      writeJsonSafely(configPath, {
        theme: "changed",
        mcpServers: { sample: { command: "node", args: ["new.js"] } },
      }),
    ).rejects.toThrow("Synthetic backup creation failure.");

    expect(await readFile(configPath, "utf8")).toBe(original);
  });
});
