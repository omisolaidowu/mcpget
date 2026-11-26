#!/usr/bin/env node
import { Command } from "commander";
import { registerSearchCommand } from "./commands/search.js";
import { registerInspectCommand } from "./commands/inspect.js";
import { registerInstallCommand } from "./commands/install.js";
import { registerManagementCommands } from "./commands/manage.js";
import {
  CliError,
  failureResponse,
  printJson,
  safeTerminalText,
} from "./output.js";
import { packageVersion } from "../package-version.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("mcpget")
    .description("Find, install, configure, and verify MCP servers.")
    .version(packageVersion, "-V, --version", "display version number");

  registerSearchCommand(program);
  registerInspectCommand(program);
  registerInstallCommand(program);
  registerManagementCommands(program);
  return program;
}

export function configureParserErrors(
  program: Command,
  argv: readonly string[],
): void {
  const jsonCommand = argv.includes("--json")
    ? argv.find((argument) =>
        [
          "search",
          "inspect",
          "install",
          "remove",
          "clients",
          "list",
          "doctor",
          "recover",
        ].includes(argument),
      )
    : undefined;

  const writeErr = (message: string): void => {
    if (jsonCommand) {
      const detail = safeTerminalText(
        message.replace(/^error:\s*/i, "").trim(),
        500,
      );
      printJson(
        failureResponse(jsonCommand, new CliError("INVALID_INPUT", detail)),
      );
    } else {
      process.stderr.write(message);
    }
  };
  program.configureOutput({ writeErr });
  for (const command of program.commands) command.configureOutput({ writeErr });
}

export const program = createProgram();

try {
  const argv = process.argv.slice(2);
  configureParserErrors(program, argv);
  const processExit = process.exit.bind(process);
  process.exit = ((code?: number | string | null) => {
    const numericCode =
      typeof code === "number"
        ? code
        : typeof code === "string"
          ? Number(code)
          : 0;
    processExit(numericCode === 0 ? 0 : numericCode === 1 ? 2 : numericCode);
  }) as typeof process.exit;
  program.exitOverride((error) => {
    const exitCode = (error as { exitCode?: number }).exitCode ?? 1;
    process.exitCode = exitCode === 0 ? 0 : 2;
    throw error;
  });
  await program.parseAsync();
} catch (error) {
  const exitCode = (error as { exitCode?: number }).exitCode;
  process.exitCode = exitCode === 0 ? 0 : 2;
}
