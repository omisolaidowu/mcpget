declare module "commander" {
  export class Command {
    name(): string;
    name(value: string): this;
    description(value?: string): this;
    version(value: string, flags?: string, description?: string): this;
    command(signature: string): Command;
    option(flags: string, description: string): this;
    action(handler: (...args: string[]) => void | Promise<void>): this;
    opts(): Record<string, unknown>;
    parse(args?: readonly string[]): this;
    parseAsync(args?: readonly string[]): Promise<this>;
    readonly commands: Command[];
  }
}
