# Product requirements document

## Product vision

Make it straightforward and safer for people to connect SaaS products to AI applications that support the Model Context Protocol (MCP). A user should be able to start with a service URL, understand available integration options and their evidence, choose a compatible client, and proceed with informed consent.

## Direction update: installer-first experience

The primary workflow is `mcpget install <server> <client>`, with a required explicit client target. Product value is Find → Install → Authenticate → Configure → Verify. Discovery and evaluation remain supporting features; the Registry is not the product experience. Current install behavior is limited to configuring a supported source in one selected client. MCPGet does not yet perform OAuth, securely store manually supplied credentials, launch the server to verify it, or confirm a working MCP connection. Never describe a configuration write as a completed authenticated installation.

## Problem statement

Finding a suitable MCP server, assessing who operates it, understanding client compatibility, and configuring it can require research across disconnected sources. A URL-first CLI could consolidate this journey while making uncertainty and risk visible.

## Target users

- Developers who use MCP-capable AI clients.
- Technical users connecting SaaS services to local AI tools.
- MCP server publishers seeking discoverability.
- Maintainers integrating new registries and client configuration formats.

## Core use cases

1. Discover candidates associated with a SaaS service.
2. Compare candidate publisher and security evidence.
3. Check whether an AI client can use a candidate's transport and authentication model.
4. Review and approve installation changes.
5. Inspect, diagnose, list, and remove managed integrations.

## Functional requirements

Future functionality is planned, not implemented in this foundation:

- Accept a service URL and derive candidates from documented discovery sources.
- Preserve provenance for candidate metadata and verification evidence.
- Explain trust signals and unknowns without presenting a score as proof.
- Detect or let users select client adapters and show compatibility limits.
- Preview configuration changes, back up existing files, and require explicit confirmation.
- Support listing, diagnosis, and removal of MCPGet-managed entries.
- Keep registry and client integrations extensible behind interfaces.

## Non-functional requirements

- TypeScript strict mode and supported Node.js runtime.
- Windows is the first development target; architecture should allow macOS and Linux.
- Clear diagnostics, deterministic behavior where possible, and secret-safe logs.
- Avoid overwriting unrelated configuration and provide recoverable changes.
- Automated tests for significant behavior and documentation for supported integrations.

## MVP scope

The intended MVP is a CLI workflow for URL-based candidate discovery, transparent trust information, client compatibility assessment, and consent-based guided installation for a small documented set of clients. Exact registry sources, supported clients, transports, and installation capability remain subject to research and owner approval.

The current repository milestone is narrower: tooling, docs, CI, and a CLI shell with help/version and pending commands only.

## Non-goals

- Building an AI client or MCP server.
- Guaranteeing that a server is safe or endorsed.
- Silent installation or execution of arbitrary packages.
- Modifying client configuration without user review and confirmation.
- Supporting every client, registry, operating system, or authentication scheme in the first release.
- Publishing to npm as part of repository initialization.

## CLI command specifications (planned)

| Command | Intended purpose | Foundation behavior |
| --- | --- | --- |
| `mcpget add <url>` | Discover, review, and optionally configure a service integration | Pending message only |
| `mcpget search <query>` | Search discovery sources | Pending message only |
| `mcpget inspect <server>` | Show candidate metadata and evidence | Pending message only |
| `mcpget list` | List MCPGet-managed integrations | Pending message only |
| `mcpget remove <server>` | Remove a managed integration after review | Pending message only |
| `mcpget doctor` | Diagnose local setup | Pending message only |
| `mcpget clients` | Show supported/detected clients | Pending message only |
| `mcpget --help`, `mcpget --version` | Explain the command surface and report version | Implemented |

Arguments and options may change after requirements and platform research.

## Success criteria

- Users can understand candidate provenance, verification status, and unresolved risk before acting.
- Supported workflows preserve unrelated configuration and require explicit approval.
- A new client or registry adapter can be added without coupling core discovery to installation.
- Automated tests cover discovery inputs, trust evidence handling, compatibility decisions, and configuration safety before release.
- Users can complete the documented MVP workflow on supported platforms.

## Future opportunities

Potential directions include community directory adapters, publisher verification partnerships, richer policy controls, organization-managed allowlists, offline candidate review, and additional client adapters. These are exploratory and require separate prioritization.
