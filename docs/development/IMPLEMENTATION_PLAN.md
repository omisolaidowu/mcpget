# Implementation plan

Milestones are sequential; the owner has authorized an installer-first direction. Discovery/evaluation remains available while configuration management is built.

## Milestone 0: Repository foundation

- **Objectives:** establish TypeScript/Node project, documentation, development conventions, CI, and CLI shell.
- **Deliverables:** strict compiler config, help/version CLI, pending command registrations, tests/tooling, project docs.
- **Dependencies:** Node.js 20+, npm.
- **Acceptance criteria:** clean install; lint, type check, tests, and build pass; help/version work; placeholders make no discovery or configuration changes.
- **Testing requirements:** unit coverage of placeholder registration and pending output; run CI checks locally.

## Milestone 1: URL and registry discovery

- **Objectives:** define URL normalization and query researched discovery sources.
- **Deliverables:** input validation, domain resolver, registry adapter interface and initial verified adapter, normalized candidate model with provenance.
- **Dependencies:** Milestone 0; current official registry/API and domain-handling research.
- **Acceptance criteria:** valid/invalid URL behavior documented; adapter follows verified contract; source provenance and pagination behavior represented; failures are bounded and clear.
- **Testing requirements:** unit tests for normalization and parsing; adapter contract tests with fixtures; integration tests mocked by default, with no hidden network dependency.

## Milestone 2: Candidate matching and trust

- **Objectives:** match candidates to a service and present evidence and unknowns.
- **Deliverables:** matching policy, evidence model, explainable trust classifications, provenance and freshness display.
- **Dependencies:** Milestone 1; documented verification sources and threat model.
- **Acceptance criteria:** matching rationale is inspectable; no unsupported official/safe claims; missing data remains unknown.
- **Testing requirements:** adversarial and boundary cases; fixtures for verified, conflicting, stale, and absent evidence.

## Milestone 3: Client detection

- **Objectives:** identify supported clients and compare capabilities.
- **Deliverables:** client adapter interface, researched initial adapters, capability and compatibility report.
- **Dependencies:** Milestone 2; current platform documentation for each client and OS.
- **Acceptance criteria:** detection is optional and can be overridden; unknown clients are reported as unknown; unsupported transport/auth combinations are explained.
- **Testing requirements:** adapter tests with temporary directories/fixtures; tests for permissions, absent clients, and platform differences.

## Milestone 4: Installation engine

- **Objectives:** safely preview and apply user-approved client configuration changes.
- **Deliverables:** change plan, explicit confirmation, backups, safe writes, rollback, list/remove operations.
- **Dependencies:** Milestone 3; established configuration formats and threat review.
- **Acceptance criteria:** no mutation before confirmation; preserve unrelated settings; recover from interrupted or partial writes; removal targets only managed entries.
- **Testing requirements:** file-system tests using temporary locations; snapshots for preservation; failure injection and rollback cases.

### Current install/configuration status

Initial package and HTTPS endpoint plans, interactive consent, isolated persistent npm installation, managed executable resolution, MCP checks against the managed package, Claude local stdio/Cursor JSON configuration, direct Codex user-scope TOML management, backups, rollback, and persistent step states are present. Python and OCI remain explicit ephemeral options. Client presence detection is partial, and authentication/connection states cannot be refreshed after the initial setup check. Manual credentials and an OS credential bridge remain unsupported.

The official MCP client SDK has verified a real stdio reference server (`@modelcontextprotocol/server-everything@2.3.1`) in a separately confirmed manual test. This did not mutate a real client config or test a third-party SaaS account.

## Milestone 5: Authentication and connection verification

- **Objectives:** support documented authentication flows and validate configured connections.
- **Deliverables:** auth abstractions, secret-safe handling, bounded verification and useful diagnostics.
- **Dependencies:** Milestone 4; client/server auth research and security review.
- **Acceptance criteria:** credentials are never logged; consent and scopes are clear; checks distinguish startup, auth, and service access; timeouts are bounded.
- **Testing requirements:** mocked auth and transport tests, redaction tests, timeout and cancellation coverage; no real secrets in CI.

## Milestone 6: Release preparation

- **Objectives:** harden packaging, documentation, support policy, and release workflow.
- **Deliverables:** release checklist, compatibility support policy, changelog, reproducible package review, release automation proposal.
- **Dependencies:** prior milestones complete and owner approval.
- **Acceptance criteria:** clean-install smoke test on supported OS versions; published files reviewed; docs match actual behavior; security and licensing review complete.
- **Testing requirements:** full CI, package contents inspection, platform smoke tests, and documented manual release checks. No npm publication is authorized by this plan.
