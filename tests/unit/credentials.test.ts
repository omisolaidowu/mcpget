import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { collectRequiredCredentials, CredentialPromptCancelled, formatCredentialPrompt, readHiddenInput } from "../../src/cli/credentials.js";
import { mergeRequiredInputs } from "../../src/cli/commands/install.js";
import type { RegistryInputRequirement } from "../../src/models/server-candidate.js";

const inputs: RegistryInputRequirement[] = [
  { name: "NOTION_TOKEN", required: true, secret: true, description: "Notion integration token", deployment: "local-package" },
  { name: "WORKSPACE_ID", required: true, description: "Workspace identifier", deployment: "local-package" },
];

describe("required credential prompts", () => {
  it("requests secrets as hidden values, accepts multiple values, and never returns prompt text", async () => {
    const readValue = vi.fn()
      .mockResolvedValueOnce("secret-token")
      .mockResolvedValueOnce("workspace-123");
    const result = await collectRequiredCredentials(inputs, {}, true, {
      keepExisting: vi.fn(),
      readValue,
    });
    expect(readValue.mock.calls).toEqual([
      ["NOTION_TOKEN", true, "Notion integration token"],
      ["WORKSPACE_ID", false, "Workspace identifier"],
    ]);
    expect(result.values).toEqual({ NOTION_TOKEN: "secret-token", WORKSPACE_ID: "workspace-123" });
    expect(result.skipped).toEqual([]);
  });

  it("keeps registry authentication requirements when package documentation contributes details", async () => {
    const required = mergeRequiredInputs([
      { name: "THUNDERBIT_API_KEY", required: true, secret: true, deployment: "local-package" },
    ], [
      { name: "THUNDERBIT_API_KEY", required: true, description: "API key (tb_...)", deployment: "local-package" },
    ]);
    expect(required).toEqual([{
      name: "THUNDERBIT_API_KEY",
      required: true,
      secret: true,
      description: "API key (tb_...)",
      deployment: "local-package",
    }]);
    const credentials = await collectRequiredCredentials(required, {}, true, {
      keepExisting: vi.fn(),
      readValue: vi.fn().mockResolvedValue("provided"),
    });
    expect(credentials.values).toEqual({ THUNDERBIT_API_KEY: "provided" });
    expect(credentials.skipped).toEqual([]);
  });

  it("formats API-key metadata into readable prompt text without table delimiters", () => {
    const prompt = formatCredentialPrompt("THUNDERBIT_API_KEY", "| THUNDERBIT_API_KEY | API key (tb_...) | — (required) |");
    expect(prompt).toContain("Authentication required");
    expect(prompt).toContain("Thunderbit API key");
    expect(prompt).toContain("Environment variable: THUNDERBIT_API_KEY");
    expect(prompt).toContain("Expected format: tb_...");
    expect(prompt).toContain("Enter API key:");
    expect(prompt).not.toContain("|");
    expect(prompt).not.toContain("[object Object]");
    const docsPrompt = formatCredentialPrompt("THUNDERBIT_API_KEY", "Required API key: THUNDERBIT_API_KEY (format tb_...)");
    expect(docsPrompt).toContain("Thunderbit API key");
    expect(docsPrompt).toContain("Expected format: tb_...");
    expect(docsPrompt).not.toContain("Required API key:");
    const malformedMetadataPrompt = formatCredentialPrompt("THUNDERBIT_API_KEY", "Thunderbit ` ``");
    expect(malformedMetadataPrompt).toContain("Thunderbit API key");
    expect(malformedMetadataPrompt).toContain("Enter API key:");
    expect(malformedMetadataPrompt).not.toContain("`");
  });

  it("masks raw input, restores terminal mode, pauses stdin, and supports Windows Enter", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode(mode: boolean): PassThrough;
    };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    const rawModes: boolean[] = [];
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = function (mode: boolean): PassThrough {
      rawModes.push(mode);
      this.isRaw = mode;
      return this;
    };
    output.isTTY = true;
    let rendered = "";
    output.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });

    const value = readHiddenInput(input, output, "Enter API key: ");
    input.write("hidden-value\r");
    await expect(value).resolves.toBe("hidden-value");
    expect(rendered).not.toContain("hidden-value");
    expect(rawModes).toEqual([true, false]);
    expect(input.isPaused()).toBe(true);
    input.destroy();
    output.destroy();
  });

  it("handles empty input, Ctrl+C cancellation, and non-interactive rejection", async () => {
    const makeTerminal = () => {
      const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(mode: boolean): PassThrough };
      const output = new PassThrough() as PassThrough & { isTTY: boolean };
      input.isTTY = true;
      input.isRaw = false;
      input.setRawMode = function (mode: boolean): PassThrough { this.isRaw = mode; return this; };
      output.isTTY = true;
      return { input, output };
    };
    const empty = makeTerminal();
    const emptyValue = readHiddenInput(empty.input, empty.output, "Enter token: ");
    empty.input.write("\r");
    await expect(emptyValue).resolves.toBeUndefined();
    empty.input.destroy();
    empty.output.destroy();

    const cancelled = makeTerminal();
    const cancelledValue = readHiddenInput(cancelled.input, cancelled.output, "Enter token: ");
    cancelled.input.write("\u0003");
    await expect(cancelledValue).rejects.toBeInstanceOf(CredentialPromptCancelled);
    cancelled.input.destroy();
    cancelled.output.destroy();

    const nonInteractive = makeTerminal();
    nonInteractive.input.isTTY = false;
    expect(() => readHiddenInput(nonInteractive.input, nonInteractive.output, "Enter token: ")).toThrow(/interactive terminal/i);
    nonInteractive.input.destroy();
    nonInteractive.output.destroy();
  });

  it("reports terminal input failures without exposing a value", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode(mode: boolean): PassThrough;
    };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = function (mode: boolean): PassThrough {
      if (mode) throw new Error("terminal failure");
      this.isRaw = false;
      return this;
    };
    output.isTTY = true;
    let rendered = "";
    output.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
    await expect(readHiddenInput(input, output, "Enter API key: ")).rejects.toThrow(/could not read credential input/i);
    expect(rendered).not.toContain("secret");
    expect(input.isPaused()).toBe(true);
    input.destroy();
    output.destroy();
  });

  it("retains an existing value by default and supports explicit replacement without revealing it", async () => {
    const keepExisting = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const readValue = vi.fn().mockResolvedValueOnce("replacement-secret");
    const result = await collectRequiredCredentials(
      [inputs[0]!, { ...inputs[0]!, name: "OTHER_TOKEN", description: "Other token" }],
      { NOTION_TOKEN: "old-secret", OTHER_TOKEN: "prior-other-secret" },
      true,
      { keepExisting, readValue },
    );
    expect(keepExisting).toHaveBeenCalledTimes(2);
    expect(readValue).toHaveBeenCalledWith("OTHER_TOKEN", true, "Other token");
    expect(result.values).toEqual({ NOTION_TOKEN: "old-secret", OTHER_TOKEN: "replacement-secret" });
  });

  it("records skipped inputs as incomplete and delegates cancellation to the caller", async () => {
    const skipped = await collectRequiredCredentials(inputs, {}, true, {
      keepExisting: vi.fn(),
      readValue: vi.fn().mockResolvedValue(undefined),
    });
    expect(skipped.skipped).toEqual(["NOTION_TOKEN", "WORKSPACE_ID"]);
    await expect(collectRequiredCredentials(inputs.slice(0, 1), {}, true, {
      keepExisting: vi.fn(),
      readValue: vi.fn().mockRejectedValue(new CredentialPromptCancelled()),
    })).rejects.toBeInstanceOf(CredentialPromptCancelled);
  });

  it("does not claim a retained value when the user declines replacement and skips the new value", async () => {
    const result = await collectRequiredCredentials([inputs[0]!], { NOTION_TOKEN: "old-secret" }, true, {
      keepExisting: vi.fn().mockResolvedValue(false),
      readValue: vi.fn().mockResolvedValue(undefined),
    });
    expect(result.values).toEqual({});
    expect(result.skipped).toEqual(["NOTION_TOKEN"]);
  });

  it("does not collect OAuth values or unsupported remote environment values", async () => {
    const readValue = vi.fn();
    const result = await collectRequiredCredentials([
      { name: "OAUTH_ACCESS_TOKEN", required: true, secret: true, deployment: "remote-endpoint" },
      { name: "REMOTE_API_KEY", required: true, secret: true, deployment: "remote-endpoint" },
    ], {}, false, { keepExisting: vi.fn(), readValue });
    expect(result.oauth).toEqual(["OAUTH_ACCESS_TOKEN"]);
    expect(result.unsupported).toEqual(["REMOTE_API_KEY"]);
    expect(readValue).not.toHaveBeenCalled();
  });
});
