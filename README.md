# MCPGet

**MCP server installer CLI for Claude, Codex, and Cursor.**

Discover, install, configure, and manage Model Context Protocol (MCP) servers from your terminal—without manually piecing together installation instructions and client configuration.

**Resolve → Install → Configure → Verify**

## Installation

```bash
npm install -g @idowupaul/mcpget
```

## Quick start

**Search for MCP servers**

```bash
mcpget search notion.so
```

**Inspect a server**

```bash
mcpget inspect <server-id>
```

**Install and configure**

```bash
mcpget install <server-id> claude
```

**List configured servers**

```bash
mcpget list
```

**Check your configuration**

```bash
mcpget doctor
```

Replace `<server-id>` with an identifier returned by the search command. Installation requires confirmation and may prompt you for supported credentials.

## Features

- **Discovery** — Find and evaluate MCP server candidates using the [Official MCP Registry](https://registry.modelcontextprotocol.io/).
- **Inspection** — Review server metadata and configuration requirements before installation.
- **Managed installations** — Install npm-based servers in isolated MCPGet-managed locations.
- **Client configuration** — Configure MCP servers for Claude Desktop, Cursor, and OpenAI Codex.
- **Remote servers** — Register supported HTTPS MCP endpoints.
- **Credential setup** — Collect known required environment variables interactively.
- **Verification** — Reread saved configurations and perform bounded server startup and MCP protocol checks where supported.
- **Server management** — List, remove, and diagnose configured MCP servers.

## Supported clients

| Client | Local servers | Remote servers |
|---|---|---|
| Claude Desktop | Yes | No |
| Cursor | Yes | Yes |
| OpenAI Codex | Yes | Yes |

MCPGet manages user-scope client configurations and preserves unrelated configuration entries when making changes.

## Commands

| Command | Description |
|---|---|
| `mcpget search <url-or-domain>` | Discover MCP server candidates |
| `mcpget inspect <server-id>` | Inspect a server's metadata |
| `mcpget install <server> <client>` | Install or register a server |
| `mcpget clients` | Show supported clients and configuration status |
| `mcpget list [client]` | List configured MCP servers |
| `mcpget remove <server> <client>` | Remove a server configuration |
| `mcpget doctor [client]` | Diagnose configuration and runtime availability |
| `mcpget help [command]` | Show CLI help |

Global options: `--help`, `--version`.

## Installation modes

**Managed installation**

npm-based servers are installed in persistent, isolated MCPGet-managed locations.

**Ephemeral installation**

Supported Python and OCI sources can be run using the explicit `--ephemeral` option.

**Remote servers**

Supported HTTPS MCP endpoints can be registered with compatible clients without installing a local package.

## Security

MCP servers may execute third-party code and access local resources. Only install servers you trust.

- Package installation may execute third-party code, including npm lifecycle scripts.
- Credentials may be written to client configuration files and stored in plaintext.
- Credentials are not stored in MCPGet installation metadata.
- Registry metadata is not a security certification or guarantee of publisher identity.
- Review the server and its source before installation.

## Verification

MCPGet independently rereads client configuration after making changes. Where supported, it also performs bounded server startup and MCP protocol initialization checks.

These checks do not guarantee successful authentication, application-level functionality, or that your AI client has loaded the server.

## Limitations

- Claude Desktop remote MCP configuration is not supported.
- Persistent managed installations currently support npm packages.
- PyPI and OCI sources require explicit ephemeral mode.
- `doctor` checks configuration and local executable availability; it does not connect to servers.
- MCPGet does not implement a universal OAuth flow. OAuth remains client/server-managed.

## Development

Clone the repository and run MCPGet from source:

```bash
git clone <repository-url>
cd mcpget

npm install
npm run build

node dist/cli/index.js --help
```

Run tests and checks:

```bash
npm test
npm run lint
npm run typecheck
npm run build
npm run format:check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.

## License

MIT — see [LICENSE](./LICENSE).
