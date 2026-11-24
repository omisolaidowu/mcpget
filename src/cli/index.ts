#!/usr/bin/env node
import { Command } from "commander";
import { registerSearchCommand } from "./commands/search.js";
import { registerInspectCommand } from "./commands/inspect.js";
import { registerInstallCommand } from "./commands/install.js";
import { registerManagementCommands } from "./commands/manage.js";

export const program = new Command();

program
  .name("mcpget")
  .description("Find, install, configure, and verify MCP servers.")
  .version("0.1.0", "-V, --version", "display version number");

registerSearchCommand(program);
registerInspectCommand(program);
registerInstallCommand(program);
registerManagementCommands(program);

await program.parseAsync();
