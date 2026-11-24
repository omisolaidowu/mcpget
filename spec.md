# MCPGet — Product & Engineering Blueprint

**Project type:** Open-source developer tool  
**Working name:** MCPGet  
**Initial distribution:** npm CLI  
**Primary language:** TypeScript  
**Runtime:** Node.js  
**Development approach:** Codex-assisted, milestone-based development  
**Product owner:** Founder

---

# DOCUMENT 1 — PRODUCT REQUIREMENTS DOCUMENT

## 1. Product vision

MCPGet is an open-source MCP discovery, verification, and installation CLI that helps developers connect SaaS products to compatible AI clients without manually researching MCP servers, locating packages, or editing configuration files.

A user should be able to enter a SaaS URL and have MCPGet:

1. Identify the SaaS product.
2. Discover matching MCP integrations.
3. Determine whether an integration is official or community-maintained.
4. Verify the publisher and available metadata.
5. Identify compatible AI clients.
6. Install the selected integration.
7. Guide the user through authentication.
8. Verify the connection.

**Core principle:** Users should identify the product they want to connect, not have to understand the underlying MCP infrastructure.

## 2. Problem statement

The current MCP adoption journey can involve several separate activities:

- Searching for an MCP server.
- Identifying the correct implementation.
- Determining whether the publisher is trustworthy.
- Checking compatibility with an AI client.
- Understanding whether the server is local or remote.
- Installing dependencies.
- Editing configuration files.
- Configuring authentication.
- Restarting the AI application.
- Troubleshooting connection failures.

MCPGet aims to consolidate these activities into one workflow.

## 3. Target users

### Primary users

- Developers experimenting with MCP.
- AI application users who want to connect external services.
- Developers managing multiple MCP integrations.
- Technical teams configuring AI development environments.

### Secondary users

- SaaS companies wanting to make their products easier to connect to AI applications.
- MCP server developers who want their integrations to be discoverable.
- Developers building their own MCP installation interfaces.

## 4. Core use case

A user wants to connect Linear to Cursor.

Instead of searching for a Linear MCP server and manually configuring it, they run:

```bash
mcpget add https://linear.app
```

MCPGet discovers available integrations, verifies their sources, presents compatible options, and installs the selected integration.

## 5. Functional requirements

### FR-01: URL ingestion

Accept a SaaS URL.

Requirements:
- Normalize URLs.
- Extract the registrable domain.
- Handle subdomains.
- Reject invalid URLs.
- Avoid treating arbitrary URL paths as verified vendor identities.

### FR-02: Product discovery

Search for matching MCP integrations.

Initial discovery source:
- Official MCP Registry.

Future sources:
- Curated community directories.
- MCP server cards.
- Vendor-maintained catalogs.
- Additional registries.

### FR-03: Domain matching

Determine whether a discovered integration belongs to the SaaS company.

Matching signals:
- Verified registry namespace.
- Publisher identity.
- Repository ownership.
- Official company documentation.
- Domain ownership evidence.
- Links from the company's official website.

A matching product name alone must never establish official ownership.

### FR-04: Trust classification

Every result must have an explicit trust classification:

- Officially verified.
- Officially claimed, not independently verified.
- Community-maintained.
- Unverified.
- Suspicious or rejected.

The product must distinguish verified facts from inferred confidence.

### FR-05: Compatibility detection

Identify whether an integration supports:
- Local stdio.
- Remote Streamable HTTP.
- Legacy SSE, where supported.

Determine whether the target AI client supports the server's transport and authentication requirements.

### FR-06: Client detection

Identify installed and supported AI clients.

Initial candidates:
- Cursor.
- Claude Desktop.

Additional candidates:
- VS Code.
- Windsurf.
- Other MCP-compatible clients.

### FR-07: Installation

Install compatible integrations into supported clients.

Requirements:
- Preserve existing configurations.
- Create backups.
- Avoid duplicate entries.
- Validate configuration before writing.
- Support rollback.
- Display changes before applying them.
- Require explicit user confirmation.

### FR-08: Authentication

Identify authentication requirements and provide appropriate instructions.

Initial support:
- No-auth integrations.
- User-supplied environment variables where required.
- Compatible OAuth flows as a subsequent milestone.

Never log access tokens or secrets.

### FR-09: Connection verification

Where possible:
- Check server availability.
- Verify the configured command or endpoint.
- Verify protocol initialization.
- Report connection failures.
- Provide actionable troubleshooting information.

### FR-10: Integration management

Provide commands to inspect, list, remove, and diagnose installed integrations.

## 6. Non-functional requirements

- TypeScript strict mode.
- Modular architecture.
- Cross-platform design.
- Windows-first initial testing.
- Unit and integration tests.
- Structured error handling.
- No silent installation.
- No arbitrary package execution without informed approval.
- No unnecessary credential collection.
- Secure configuration backups.
- Clear logging without secrets.
- Maintainable client adapters.

## 7. Non-goals for MVP

The first release will not:

- Generate MCP servers from arbitrary websites.
- Generate MCP servers automatically from OpenAPI specifications.
- Guarantee installation into every AI platform.
- Bypass platform approval requirements.
- Guarantee that every SaaS product has an MCP.
- Automatically install unknown or suspicious packages.
- Provide a graphical application.
- Offer a hosted SaaS management dashboard.
- Guarantee that authentication can be completed automatically.

## 8. CLI interface

Proposed commands:

```bash
mcpget add <url>
mcpget search <url>
mcpget inspect <server>
mcpget list
mcpget remove <server>
mcpget doctor
mcpget update
mcpget clients
mcpget --version
```

Options:

```bash
mcpget add https://linear.app --client cursor

mcpget add https://linear.app --client claude

mcpget search https://linear.app

mcpget add https://linear.app --dry-run
```

The default `add` command should be interactive and guide the user through discovery, selection, trust review, and installation.

## 9. MVP success criteria

The MVP is successful when:

1. A user can provide a SaaS URL.
2. MCPGet can query the official MCP Registry.
3. It can return matching integrations.
4. It can distinguish registry metadata from independently verified ownership.
5. It can identify compatible local clients.
6. It can safely install a supported local or remote MCP configuration.
7. It preserves existing configurations.
8. It can verify basic connectivity or clearly report why verification is unavailable.
9. It passes automated tests on Windows.

---

# DOCUMENT 2 — TECHNICAL ARCHITECTURE

## 1. Technology choices

| Area | Technology |
|---|---|
| Language | TypeScript |
| Runtime | Node.js |
| CLI framework | Commander.js |
| Interactive prompts | @inquirer/prompts |
| Terminal output | Chalk and Ora |
| Validation | Zod |
| HTTP client | Native fetch |
| Configuration | JSON |
| Testing | Vitest |
| Linting | ESLint |
| Formatting | Prettier |
| Package distribution | npm |
| CI | GitHub Actions |

These are initial choices, subject to validation during project setup.

## 2. Architecture overview

```text
                   USER
                    |
                    v
               MCPGET CLI
                    |
                    v
             DISCOVERY ENGINE
                    |
          +---------+---------+
          |         |         |
          v         v         v
       Registry  Domain    Community
       Adapter   Resolver  Catalogs
          |         |         |
          +---------+---------+
                    |
                    v
              TRUST ENGINE
                    |
                    v
            INTEGRATION SELECTOR
                    |
                    v
          COMPATIBILITY DETECTION
                    |
                    v
          INSTALLATION ORCHESTRATOR
                    |
          +---------+---------+
          |         |         |
          v         v         v
       Cursor    Claude     VS Code
       Adapter   Adapter    Adapter
          |         |         |
          +---------+---------+
                    |
                    v
             CONNECTION CHECK
```

## 3. Core modules

### A. CLI module

Responsible for:
- Command parsing.
- Argument validation.
- Interactive flows.
- Output formatting.
- Error presentation.

### B. Discovery engine

Responsible for:
- URL normalization.
- Product identification.
- Registry queries.
- Candidate matching.
- Result ranking.

Discovery should be independent of installation.

### C. Registry adapters

Each registry should have its own adapter.

Initial adapter:

`OfficialMcpRegistryAdapter`

Responsibilities:
- Search servers.
- Retrieve server details.
- Retrieve server versions.
- Handle pagination.
- Normalize registry records.

The official registry API currently documents:

- `GET /v0.1/servers`
- `GET /v0.1/servers/{serverName}/versions/latest`
- `GET /v0.1/servers/{serverName}/versions/{version}`
- `GET /v0.1/servers/{serverName}/versions`

Use `version=latest` for latest-version discovery, but also inspect server status. A latest version can be deprecated.

Official API documentation:
https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md

### D. Domain resolver

Responsibilities:
- Extract company domain.
- Compare server metadata.
- Examine verified namespaces.
- Evaluate repository ownership.
- Identify official documentation references.
- Return evidence and confidence.

Important: Domain matching and publisher verification must remain separate operations.

### E. Trust engine

Produce a trust report containing:

```ts
interface TrustReport {
  classification:
    | "official_verified"
    | "official_claimed"
    | "community"
    | "unverified"
    | "suspicious";

  evidence: string[];
  warnings: string[];
  verifiedDomain?: string;
  repository?: string;
}
```

This is a proposed internal model, not a guarantee that the registry supplies every field.

### F. Compatibility engine

Evaluate:

- Client support.
- Transport support.
- Authentication requirements.
- Server execution requirements.
- Runtime dependencies.

### G. Installation orchestrator

Responsible for:
- Selecting client adapters.
- Reading configuration.
- Validating existing configuration.
- Creating backups.
- Applying changes.
- Verifying changes.
- Restoring previous configuration when necessary.

### H. Client adapters

Use a common interface:

```ts
interface ClientAdapter {
  id: string;

  detect(): Promise<boolean>;

  getConfigPath(): Promise<string | null>;

  readConfig(): Promise<unknown>;

  validateServer(server: McpServer): Promise<ValidationResult>;

  install(server: McpServer): Promise<InstallResult>;

  remove(serverId: string): Promise<RemoveResult>;

  list(): Promise<InstalledServer[]>;
}
```

Individual clients will implement the operations they actually support. Unsupported operations must return explicit capability errors rather than pretending to succeed.

### I. Connection verification

Verify:
- Configuration validity.
- Server process availability, for stdio.
- Remote endpoint availability, for HTTP.
- MCP initialization where technically supported.
- Authentication status where observable.

A successful HTTP response alone must not be reported as a successful MCP connection.

## 4. Proposed project structure

```text
mcpget/
│
├── src/
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── add.ts
│   │   │   ├── search.ts
│   │   │   ├── inspect.ts
│   │   │   ├── list.ts
│   │   │   ├── remove.ts
│   │   │   └── doctor.ts
│   │   └── index.ts
│   │
│   ├── discovery/
│   │   ├── registry/
│   │   │   └── official-registry.ts
│   │   ├── domain-resolver.ts
│   │   ├── matcher.ts
│   │   └── discovery-engine.ts
│   │
│   ├── trust/
│   │   ├── verifier.ts
│   │   ├── evidence.ts
│   │   └── classifier.ts
│   │
│   ├── compatibility/
│   │   ├── transport.ts
│   │   └── compatibility-engine.ts
│   │
│   ├── installers/
│   │   ├── adapter.ts
│   │   ├── cursor.ts
│   │   ├── claude-desktop.ts
│   │   └── vscode.ts
│   │
│   ├── config/
│   │   ├── backup.ts
│   │   ├── reader.ts
│   │   └── writer.ts
│   │
│   ├── verification/
│   │   └── connection-check.ts
│   │
│   ├── models/
│   │   ├── server.ts
│   │   └── results.ts
│   │
│   ├── utils/
│   │   ├── url.ts
│   │   ├── logger.ts
│   │   └── errors.ts
│   │
│   └── index.ts
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
│
├── docs/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── CONTRIBUTING.md
├── LICENSE
└── .github/
    └── workflows/
```

## 5. Installation security model

The installer must:

1. Resolve the server metadata.
2. Validate the proposed installation configuration.
3. Identify whether installation executes local code or connects to a remote service.
4. Display the publisher, command, endpoint, requested permissions, and dependencies.
5. Obtain explicit user approval.
6. Back up the existing configuration.
7. Apply changes atomically where possible.
8. Validate the resulting configuration.
9. Provide rollback.

Never automatically trust a package because its name resembles the SaaS company.

Never store user credentials in the MCPGet configuration unless a specific, documented credential-storage design requires it.

## 6. Important technical research

Official documentation to consult during development:

- MCP Registry API: https://github.com/modelcontextprotocol/registry
- MCP specification: https://modelcontextprotocol.io/
- Cursor MCP: https://cursor.com/docs/mcp
- Claude Desktop extensions: https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop
- VS Code MCP: https://code.visualstudio.com/docs/agent-customization/mcp-servers

---

# DOCUMENT 3 — CODEX IMPLEMENTATION PLAN

## Development principles

- Implement one milestone at a time.
- Never ask Codex to generate the entire application in one prompt.
- Require tests for every significant feature.
- Keep commits small and reviewable.
- Avoid premature abstractions.
- Keep the registry and client adapters independent.
- Do not introduce automatic package execution without an explicit security review.

## Milestone 0 — Repository foundation

Deliverables:
- Initialize TypeScript project.
- Configure Node.js compatibility.
- Configure Commander.js.
- Configure Vitest.
- Configure ESLint and Prettier.
- Create the project structure.
- Add initial README.
- Add GitHub Actions.

Acceptance criteria:
- Project builds.
- Tests execute.
- CLI responds to `--help`.
- CLI responds to `--version`.

## Milestone 1 — URL and registry discovery

Deliverables:
- URL normalization.
- Domain extraction.
- Official registry API client.
- Search functionality.
- Pagination.
- Server detail retrieval.
- Version and status handling.

Acceptance criteria:
- `mcpget search https://linear.app` executes.
- Registry results are parsed into internal models.
- Invalid URLs are rejected.
- API failures are handled gracefully.
- Multiple server versions are handled correctly.

## Milestone 2 — Candidate matching and trust

Deliverables:
- Domain matching.
- Namespace analysis.
- Repository evidence extraction.
- Trust classifications.
- Human-readable inspection output.

Acceptance criteria:
- Results are not automatically considered official.
- Trust classification includes evidence.
- Ambiguous results are clearly identified.
- Suspicious results cannot be installed silently.

## Milestone 3 — Client detection

Deliverables:
- Client adapter interface.
- Windows detection for Claude Desktop.
- Windows detection for Cursor.
- Configuration path resolution.
- Existing configuration inspection.

Acceptance criteria:
- Installed clients are identified.
- Missing clients are reported.
- Existing configuration files are not modified.
- Unknown configurations produce safe errors.

## Milestone 4 — Installation engine

Deliverables:
- Configuration parser.
- Configuration writer.
- Backup manager.
- Duplicate detection.
- Local stdio installation.
- Remote HTTP installation.
- Rollback.

Acceptance criteria:
- Existing MCP entries are preserved.
- Invalid configurations are not written.
- Duplicate installations are prevented.
- Changes can be reversed.
- User approval is mandatory.

## Milestone 5 — Authentication and verification

Deliverables:
- Authentication requirement detection.
- Environment variable support.
- OAuth feasibility assessment.
- Connection checks.
- Diagnostic command.

Acceptance criteria:
- Missing credentials are reported.
- Secrets are not printed in logs.
- Connection failures are actionable.
- Successful configuration is not confused with successful authentication.

## Milestone 6 — Release preparation

Deliverables:
- npm packaging.
- Documentation.
- Installation instructions.
- Usage examples.
- Windows CI.
- Security policy.
- Contribution guide.
- Open-source release.

Acceptance criteria:
- Fresh installation works.
- Core workflows pass.
- Documentation matches actual behavior.
- No secrets or credentials are committed.

---

# CODEX WORKING INSTRUCTIONS

Use the following as the initial project instruction file, preferably saved as `AGENTS.md`:

## Project identity

You are contributing to MCPGet, an open-source MCP discovery, verification, and installation CLI.

The project owner's objective is to make connecting SaaS products to AI clients as frictionless as possible.

## Engineering rules

1. Use TypeScript with strict type checking.
2. Prefer small, composable modules.
3. Do not combine discovery, verification, compatibility, and installation into one module.
4. Use interfaces for registry adapters and client adapters.
5. Write tests before or alongside implementation.
6. Preserve existing user configuration.
7. Require explicit confirmation before installation.
8. Never log credentials.
9. Do not execute arbitrary packages without informed consent.
10. Document important technical decisions.
11. Do not invent undocumented client capabilities.
12. Verify current official documentation when implementing platform-specific behavior.
13. Report unsupported features honestly.
14. Do not silently broaden project scope.

## Codex workflow

For every task:

1. Read the relevant project documentation.
2. Inspect existing code before editing.
3. Explain the intended implementation briefly.
4. Implement only the requested milestone.
5. Add or update tests.
6. Run relevant tests and type checks.
7. Report changed files, results, and unresolved issues.
8. Do not move to another milestone without approval.

## Definition of done

A feature is complete only when:
- Its requirements are implemented.
- Relevant tests pass.
- Error cases are handled.
- Security implications are reviewed.
- Documentation is updated where necessary.

---

# FIRST DEVELOPMENT TASK

Start with Milestone 0 only.

Do not implement registry discovery or installation yet.

The objective is to establish a clean, testable TypeScript CLI foundation that we can confidently extend.

**First product validation target:** A user on Windows can install MCPGet, execute `mcpget --help`, and see the supported commands.

---

# PRODUCT OWNER'S OPEN QUESTIONS

These decisions should be revisited before the relevant milestones:

1. Should MCPGet support only MCP initially, or eventually include other integration formats such as skills and native plugins?
2. Should the first release prioritize local desktop clients or also attempt hosted AI platforms?
3. Should discovery include only the official registry initially, or curated community sources from the first release?
4. Should the tool be entirely local, with no user account or central backend?
5. Should the eventual commercial layer allow SaaS vendors to register, verify, and manage their integrations?

**Guiding principle:** Build the smallest useful product that proves the discovery-to-installation workflow. Do not build the eventual commercial platform before the open-source product demonstrates demand.