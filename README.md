# MCPGet

**The MCP server installer and configuration manager for developers and AI agents.**

Discover, inspect, install, configure, and manage Model Context Protocol (MCP) servers without manually piecing together package instructions, environment variables, and client configuration files.

Whether you're setting up an MCP server yourself or asking an AI coding agent to do it, MCPGet provides a consistent workflow for managing the process.

**Resolve → Install → Configure → Verify**

[![npm version](https://img.shields.io/npm/v/@idowupaul/mcpget)](https://www.npmjs.com/package/@idowupaul/mcpget)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## Table of contents

- [Why MCPGet?](#why-mcpget)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Finding and installing MCP servers](#finding-and-installing-mcp-servers)
- [MCPGet for AI agents](#mcpget-for-ai-agents)
  - [Find an MCP server](#find-an-mcp-server)
  - [Install a server into an AI client](#install-a-server-into-an-ai-client)
  - [Diagnose an existing installation](#diagnose-an-existing-installation)
  - [List configured servers](#find-out-which-servers-are-configured)
  - [Remove an MCP server](#remove-an-mcp-server)
  - [Automate an installation](#automate-an-installation)
- [Features](#features)
- [Supported clients](#supported-clients)
  - [Configuration scopes](#configuration-scopes)
  - [GitHub Copilot configuration](#github-copilot-configuration)
  - [Claude Code configuration](#claude-code-configuration)
  - [OpenAI Codex configuration](#openai-codex-configuration)
- [CLI reference](#cli-reference)
- [Machine-readable output](#machine-readable-output)
- [Installation modes](#installation-modes)
- [Security](#security)
- [Verification](#verification)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## Why MCPGet?

Installing an MCP server often involves several disconnected steps:

- Finding a suitable server for a particular service.
- Determining which implementation or package to use.
- Understanding its installation and configuration requirements.
- Installing dependencies and supplying credentials.
- Editing the correct configuration file for your AI client.
- Checking whether the configuration and server actually work.

The process becomes even more cumbersome when you work with multiple AI clients or delegate setup to an AI coding agent.

MCPGet brings these steps together in one CLI.

Instead of manually configuring every server, you can ask MCPGet to resolve a candidate, install it, configure your client, and perform supported verification checks.

## Installation

Install MCPGet globally using npm:

```bash
npm install -g @idowupaul/mcpget
```

Check that it is available:

```bash
mcpget --version
```

## Quick start

### 1. Find an MCP server

Search for servers associated with a service:

```bash
mcpget search notion.so
```

### 2. Inspect a candidate

Use an identifier returned by the search command:

```bash
mcpget inspect <server-id>
```

### 3. Install and configure

For example, install a selected server into Claude Desktop:

```bash
mcpget install <server-id> claude
```

MCPGet resolves the installation source, installs the server where supported, collects required configuration inputs, and updates the selected client's configuration.

### 4. List configured servers

```bash
mcpget list
```

### 5. Diagnose your setup

```bash
mcpget doctor
```

Installation normally requires confirmation. MCPGet may also ask for supported credentials or other required configuration inputs.

## Finding and installing MCP servers

MCPGet supports multiple ways to identify an MCP server.

### Search by service or domain

```bash
mcpget search notion
mcpget search github.com
mcpget search notion.so --limit 10
```

Search uses the Official MCP Registry to discover and rank candidates.

By default, MCPGet returns up to five ranked candidates. Use `--limit` to request more.

When multiple candidates match, review the available options rather than assuming the first result is necessarily the right implementation.

### Install using a service name or domain

```bash
mcpget install notion codex
mcpget install github claude
mcpget install notion.com cursor
```

MCPGet resolves the input against available Registry candidates.

### Install using an npm package reference

```bash
mcpget install npm:<package-name> codex
```

Use this when you already know the npm package you want to install.

### Select a specific Registry candidate

```bash
mcpget install <server-id> cursor
```

You can also select an exact Registry candidate when resolving an ambiguous service:

```bash
mcpget install notion codex --candidate <registry-id>
```

### Inspect before installing

```bash
mcpget inspect <server-id>
```

Inspection provides more detailed information about the candidate, including its Registry metadata, operational requirements, evaluation evidence, and available safety indicators.

Use inspection to make an informed decision before installing third-party code.

### Install a Python or OCI server

Persistent managed installations currently support npm packages.

Supported Python and OCI sources require explicit ephemeral mode:

```bash
mcpget install <server-id> codex --ephemeral
```

Ephemeral mode does not provide the same persistent managed-installation behavior as npm installations.

## MCPGet for AI agents

MCPGet is designed to be usable from a terminal, making it suitable for AI coding agents that have permission to execute local commands.

An agent can use MCPGet to discover servers, inspect installation requirements, configure supported clients, and diagnose existing installations.

You don't need to manually explain every configuration file or installation step to your agent.

### Find an MCP server

**Example prompt:**

> Find an MCP server for Notion. Compare the available candidates, inspect the strongest match, and explain its installation requirements. Don't install anything yet.

The agent can run:

```bash
mcpget search notion
mcpget inspect <server-id>
```

It should present the available candidates and explain why it recommends one before proceeding.

### Install a server into an AI client

**Example prompt:**

> Install the selected Notion MCP server into Cursor. Ask me for any required credentials, preserve my existing configuration, and verify the installation.

The agent can run:

```bash
mcpget install <server-id> cursor
```

MCPGet handles the supported installation and configuration workflow. The agent can then inspect the result and report any verification limitations.

### Diagnose an existing installation

**Example prompt:**

> Check my configured MCP servers. Identify broken configurations, missing executables, or incomplete installations. Explain what needs attention without modifying anything.

The agent can run:

```bash
mcpget clients
mcpget list
mcpget doctor
```

### Find out which servers are configured

**Example prompt:**

> Show me the MCP servers configured for Claude Code and explain which ones are managed by MCPGet.

The agent can run:

```bash
mcpget list claude-code
```

### Remove an MCP server

**Example prompt:**

> Remove the specified MCP server from Claude Code without affecting other configured servers.

The agent can run:

```bash
mcpget remove <server-name> claude-code
```

### Automate an installation

MCPGet supports structured JSON output and explicit approval for non-interactive workflows.

**Example prompt:**

> Install this MCP server into Codex non-interactively. Use the required environment variables already available to the process, explicitly approve the installation, and return the result as JSON. Do not expose credential values.

The agent can run:

```bash
mcpget install <server-id> codex --yes --json
```

For this workflow, required credential variables must be available in the process environment.

**Important:** These are examples of prompts you can give an AI agent with terminal access. They are not built-in MCPGet chat commands. The agent still needs appropriate local permissions and access to the terminal.

## Features

| Capability | What it does |
|---|---|
| Discovery | Finds and ranks MCP server candidates through the Official MCP Registry |
| Inspection | Presents metadata, operational requirements, evaluation evidence, and safety indicators |
| Managed installation | Installs npm-based servers in isolated MCPGet-managed locations |
| Client configuration | Configures supported MCP clients without replacing unrelated entries |
| Remote registration | Registers supported HTTPS MCP endpoints |
| Credential setup | Collects known required environment variables interactively |
| Verification | Rereads configuration and performs bounded startup and protocol checks where supported |
| Server management | Lists, removes, and diagnoses configured MCP servers |
| Agent automation | Provides JSON output and non-interactive workflows for terminal-based agents |
| Recovery | Reconciles interrupted operations and diagnoses incomplete transactions |

## Supported clients

MCPGet supports six client surfaces:

| Client | Local servers | Remote servers |
|---|---:|---:|
| Claude Desktop | Yes | No |
| Claude Code | Yes | Yes |
| GitHub Copilot for VS Code | Yes | Yes |
| GitHub Copilot CLI | Yes | Yes |
| Cursor | Yes | Yes |
| OpenAI Codex | Yes | Yes |

### Configuration scopes

MCPGet preserves unrelated configuration entries and modifies only the selected target.

| Client | Supported scopes |
|---|---|
| Claude Desktop | User |
| Claude Code | User, local, trusted project |
| GitHub Copilot for VS Code | User, project |
| GitHub Copilot CLI | User, project |
| Cursor | User |
| OpenAI Codex | User, trusted project |

### GitHub Copilot configuration

GitHub Copilot for VS Code and Copilot CLI share a user-level configuration file:

```text
$COPILOT_HOME/mcp-config.json
```

When `COPILOT_HOME` is unset, MCPGet uses:

```text
~/.copilot/mcp-config.json
```

MCPGet treats the VS Code and CLI user-level configuration as one shared target.

For project-level configuration:

- Copilot VS Code uses `.mcp.json` at the workspace or repository root, with top-level `mcpServers`.
- Copilot CLI supports `.mcp.json` and `.github/mcp.json`, including its native `mcpServers` and bare-server forms.

Project definitions take precedence over the shared user configuration for matching server names. MCPGet preserves user and project entries separately and requires explicit scope selection when necessary.

### Claude Code configuration

Claude Code supports three configuration scopes:

| Scope | Configuration location |
|---|---|
| User | Top-level `mcpServers` in `~/.claude.json` |
| Local | `projects[project-root].mcpServers` in `~/.claude.json` |
| Project | Top-level `mcpServers` in the project-root `.mcp.json` |

Project scope requires Claude Code to have accepted the trust dialog for the current project. It is also subject to Claude Code's separate project approval state.

Configuration overrides:

- `MCPGET_CLAUDE_CODE_CONFIG_PATH` overrides the Claude Code state file.
- `CLAUDE_CONFIG_DIR` uses Claude Code's native configuration-directory override.

### OpenAI Codex configuration

Codex supports user and trusted project configurations.

Project configuration is inspected only when Codex marks the project as trusted. MCPGet does not create or modify an untrusted project configuration.

When multiple applicable project configuration layers exist, select the exact target using `--config`.

## CLI reference

Run:

```bash
mcpget --help
```

For command-specific help:

```bash
mcpget help install
```

### Discovery and inspection

| Command | Description |
|---|---|
| `mcpget search <url-or-domain> [--limit <count>]` | Discover and rank candidates |
| `mcpget inspect <server-id>` | Inspect a candidate's metadata and evaluation |

### Installation

| Command | Description |
|---|---|
| `mcpget install <server> <client>` | Install or register a server |
| `mcpget install ... --candidate <registry-id>` | Select an exact Registry candidate |
| `mcpget install ... --source <source>` | Select an exact installation source |
| `mcpget install ... --scope user\|project\|local` | Select a configuration scope |
| `mcpget install ... --config <path>` | Select an exact Codex configuration file |
| `mcpget install ... --codex-profile <profile>` | Include an explicitly selected Codex profile |
| `mcpget install ... --ephemeral` | Use supported ephemeral installation mode |
| `mcpget install ... --allow-lifecycle-scripts` | Explicitly authorize package lifecycle scripts |
| `mcpget install ... --yes --json` | Approve and return a structured installation result |

### Client and server management

| Command | Description |
|---|---|
| `mcpget clients` | Show supported clients and configuration status |
| `mcpget list [client]` | List configured MCP servers |
| `mcpget list codex --scope user\|project` | Inspect a Codex scope |
| `mcpget remove <server> <client>` | Remove a server configuration |
| `mcpget remove ... --config <path>` | Remove from one exact Codex configuration |
| `mcpget remove ... --yes --json` | Approve and return a structured removal result |
| `mcpget doctor [client]` | Diagnose configuration and executable availability |
| `mcpget doctor codex --config <path>` | Diagnose an exact Codex configuration |

### Recovery

| Command | Description |
|---|---|
| `mcpget recover` | Reconcile interrupted operations after approval |
| `mcpget recover --scope user\|project` | Limit recovery to a Codex scope |
| `mcpget recover --yes --json` | Approve and report non-interactive recovery actions |
| `mcpget recover --archive-orphaned-backup <client> --yes` | Archive a validated orphaned backup |

### Global options

```text
--help
--version
```

Codex project configuration is inspected only when the project is trusted. If multiple trusted project configuration layers are available, select one exact path with `--config`. Non-interactive workflows require explicit selection.

Duplicate checks inspect applicable Codex user/profile and trusted project configurations. An installation modifies only the explicitly selected target.

## Machine-readable output

MCPGet supports JSON output for:

```bash
mcpget search notion --json
mcpget inspect <server-id> --json
mcpget install <server-id> codex --yes --json
mcpget remove <server-name> codex --yes --json
mcpget clients --json
mcpget list --json
mcpget doctor --json
mcpget recover --yes --json
```

Successful operations use a consistent response envelope:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "clients",
  "data": {},
  "warnings": []
}
```

Errors use the same top-level structure:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "command": "install",
  "error": {
    "code": "INVALID_INPUT",
    "message": "Invalid installation input"
  },
  "warnings": []
}
```

### Error codes

| Code | Meaning |
|---|---|
| `INVALID_INPUT` | Invalid command or input |
| `UNSUPPORTED_OPERATION` | Unsupported operation or source |
| `MISSING_REQUIRED_INPUT` | Required input or approval is missing |
| `OPERATIONAL_FAILURE` | General operational failure |
| `CANCELLED` | Operation cancelled |

### Process exit codes

| Code | Meaning |
|---:|---|
| `0` | Success |
| `1` | General operational failure |
| `2` | Invalid input |
| `3` | Unsupported operation or source |
| `4` | Missing required input or approval |
| `130` | Cancelled |

### Non-interactive credentials

For non-interactive JSON installation, MCPGet can use inherited process environment variables when the variable name is a required input declared for the selected server.

For example, in Bash:

```bash
export NOTION_TOKENS_DIR="$HOME/.config/notion-tokens"
mcpget install <server-id> codex --yes --json
```

In Windows PowerShell:

```powershell
$env:NOTION_TOKENS_DIR = "$HOME\.config\notion-tokens"
mcpget install <server-id> codex --yes --json
```

MCPGet reports variable names and credential types, not secret values. Conflicting existing client environment values are replaced only by an explicitly approved inherited value.

Credential configuration, authentication, and MCP protocol verification are separate outcomes.

Remote endpoints do not accept environment-variable injection. Use the authentication flow supported by the client and server.

### Search and inspection schemas

Search uses data schema version 3 while retaining the outer JSON envelope at schema version 1.

Search candidate statuses include:

- `recommended`
- `candidate`
- `similar_candidates`
- `no_recommendation`

A `candidateId`, when present, identifies the top-ranked eligible candidate. It does not mean the server has been independently verified.

Search ranks candidates before applying `--limit`. Its summary separates discovered, matched, returned, omitted, and unrelated-excluded counts. Discovery completeness and termination reason are reported separately.

Use:

```bash
mcpget inspect <server-id> --for <service> --json
```

for detailed evaluation evidence, full descriptions, security findings, maintenance signals, and operational requirements.

Registry descriptions and inferred capability claims are not independent security or runtime verification.

## Installation modes

### Managed npm installations

MCPGet installs npm-based servers in persistent, isolated managed locations.

This allows MCPGet to track managed installations and coordinate their lifecycle with client configuration.

### Ephemeral installations

Supported Python and OCI sources require explicit ephemeral mode:

```bash
mcpget install <server-id> codex --ephemeral
```

These sources do not receive the same persistent managed-installation behavior as npm packages.

### Remote HTTPS servers

MCPGet can register supported HTTPS MCP endpoints with compatible clients without installing a local package.

Claude Desktop remote MCP configuration is not supported.

## Security

MCP servers are third-party programs. They may execute code, access local resources, and handle sensitive information.

Only install servers and packages you trust.

### Package lifecycle scripts

Package installation scripts can execute code on your computer.

MCPGet disables lifecycle scripts by default and communicates this policy during installation confirmation.

To explicitly authorize lifecycle scripts:

```bash
mcpget install <server-id> codex --allow-lifecycle-scripts
```

For non-interactive installation, explicit authorization is required. The general `--yes` option does not authorize lifecycle scripts.

### Remote endpoint restrictions

Remote MCP endpoints must use HTTPS and resolve only to globally routable addresses.

MCPGet validates DNS destinations, pins connections to validated addresses, rejects private and local destinations, and follows only bounded same-origin redirects.

The endpoint and destination policy are presented before approval. `--yes` does not bypass validation.

Local and private remote endpoints are not supported.

### Credentials

Credentials may be written into client configuration files and stored in plaintext, depending on the client's configuration format.

Credentials are not stored in MCPGet installation metadata.

Treat client configuration files, backups, and archives as sensitive.

### Configuration recovery and backups

MCPGet uses transactional configuration updates and rollback backups.

During a configuration update or removal, it retains a backup until the change is independently verified or rollback is confirmed.

Transaction metadata records operation identifiers, outcomes, and content hashes—not configuration values.

`doctor` can identify interrupted operations, invalid or missing managed-package metadata, configuration/state mismatches, and orphaned packages.

Recovery reconciles journaled state against the current configuration. It does not arbitrarily overwrite active client configuration.

Ambiguous artifacts, incomplete transactions, and failed rollbacks are preserved for investigation. A validated orphaned backup can be archived explicitly:

```bash
mcpget recover --archive-orphaned-backup <client> --yes
```

Backup and archive files may contain plaintext credentials. On Windows, access is governed by the configuration directory's inherited ACLs.

### Process and filesystem safety

MCPGet coordinates configuration, installation-state, and managed-package changes using cross-process filesystem locks.

It recovers stale locks only when ownership can be verified. Unknown, incomplete, or remote-host ownership fails closed.

Lock coordination relies on filesystem directory creation and rename semantics. Shared or network filesystems, isolated PID namespaces, and processes reporting different hostnames may not provide verifiable ownership.

## Verification

MCPGet independently rereads client configuration after making changes.

Where supported, it also performs bounded server startup and MCP protocol initialization checks.

These checks provide useful evidence about installation and configuration, but they do not guarantee:

- Successful authentication.
- Successful application-level tool execution.
- That the target AI client has loaded the server.
- That the server is safe or trustworthy.

`doctor` checks configuration and local executable availability. It does not connect to servers.

## Limitations

- Claude Desktop remote MCP configuration is not supported.
- Persistent managed installations currently support npm packages.
- Python and OCI sources require explicit ephemeral mode.
- MCPGet does not implement a universal OAuth flow. OAuth remains client/server-managed.
- Registry metadata is not a security certification or guarantee of publisher identity.
- Search does not independently verify server capabilities, trustworthiness, or runtime compatibility.
- Protocol initialization does not prove successful authentication or application-level functionality.
- Project configuration may be restricted by the target client's trust and approval mechanisms.
- Recovery preserves ambiguous or unverifiable artifacts rather than making potentially unsafe assumptions.

## Development

Clone the repository:

```bash
git clone https://github.com/omisolaidowu/mcpget.git
cd mcpget
```

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Run tests:

```bash
npm test
npm run test:acceptance
```

Run code quality checks:

```bash
npm run lint
npm run typecheck
npm run format:check
```

Run the CLI from the build output:

```bash
node dist/cli/index.js --help
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.

## License

MIT. See [LICENSE](./LICENSE).