import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { packageVersion } from "../../src/package-version.js";

describe("package identity", () => {
  it("publishes the mcpget package and executable", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { name: string; version: string; bin: Record<string, string> };

    expect(manifest.name).toBe("@idowupaul/mcpget");
    expect(manifest.bin).toEqual({ mcpget: "dist/cli/index.js" });
    expect(packageVersion).toBe(manifest.version);
  });
});
