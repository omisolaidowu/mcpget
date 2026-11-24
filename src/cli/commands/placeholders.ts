import type { Command } from "commander";

const pendingCommands = [
  ["add <url>", "Add an integration from a SaaS URL"],
  ["list", "List configured integrations"],
  ["remove <server>", "Remove an integration"],
  ["doctor", "Check MCPGet setup"],
  ["clients", "Show compatible AI clients"],
] as const;

export function registerPlaceholderCommands(program: Command): void {
  for (const [signature, description] of pendingCommands) {
    program
      .command(signature)
      .description(`${description} (implementation pending)`)
      .action(() => {
        console.log("This command is not implemented yet.");
      });
  }
}
