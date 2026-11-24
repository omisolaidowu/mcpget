# Security model

## Current implementation limits

Installation requires interactive confirmation. Package instructions are stored as argument arrays and no shell is invoked by MCPGet. npm packages are persistently installed in a package-specific MCPGet-owned directory and run from that managed location. npm lifecycle scripts and the installed server code execute after consent. Python and OCI remain available only through explicit ephemeral mode. Known required local environment inputs can be entered interactively; secret values are hidden at the prompt and are written only to the selected client's configuration. MCPGet does not store them in installation metadata. Client configuration and its backups may contain plaintext values; users are warned before credential entry and backups are permission-restricted. Skipped requirements leave setup pending and defer startup/connection verification. OAuth remains client/server-managed; optional Codex CLI OAuth login may launch the Codex CLI. File-based JSON and TOML adapters preserve unrelated configuration and validate resulting entries. The MCP TypeScript SDK performs protocol negotiation; successful initialization is not a security certification or proof that SaaS operations will work.

This document is the security baseline for current discovery, evaluation, and initial installation/configuration behavior. MCPGet may collect required environment values for client configuration, but does not manage OAuth tokens or claim authentication based solely on configuration, login-flow completion, or MCP initialization.

## Publisher and domain verification

Keep publisher identity evidence separate from server metadata and domain association. Record the evidence source, method, timestamp, subject, and confidence/limitations. A domain match alone does not establish control or official status. Never describe a publisher as official without authoritative supporting evidence.

## Trust classifications

Prefer explainable categories such as verified evidence, partial evidence, unknown, and conflicting evidence. Show provenance and freshness. A classification communicates evidence quality, not a guarantee that code is safe.

Current Registry-only evaluation cannot independently verify publisher identity or vendor affiliation. Registry namespaces and publisher claims are shown as unverified evidence. A recommendation is not a trust rating or security certification.

## Local package execution risks

Local servers may execute code with the user's privileges. Before any future launch/install flow, disclose package identity, source, command, permissions, and execution behavior. Pin or otherwise verify artifacts where feasible; do not execute arbitrary packages silently. Review lifecycle scripts, supply-chain provenance, and update behavior.

## Remote endpoint risks

Remote endpoints can impersonate services, return malicious content, or induce requests to internal resources. Validate schemes and destinations, consider DNS rebinding and redirect behavior, bound requests, and avoid leaking credentials across origins. Domain discovery is not endpoint safety verification.

## OAuth and credential handling

Use least privilege and documented flows. Do not put secrets in command-line arguments, logs, crash output, or generated config unless the target format requires it and the user understands the implications. Prefer platform-supported secure storage only after client-specific research. Redact tokens and sensitive query parameters.

## Permission disclosure

Before consequential actions, show the server, client, files or resources affected, network destinations, permissions, and authentication scopes that are known. Unknowns should be visible. Require explicit confirmation before installation.

## Configuration backups and rollback

Create recoverable backups before writes, protect backup permissions, detect concurrent edits, preserve unrelated values, and describe how rollback works. Removal must be limited to MCPGet-managed records and retain user data by default.

## Logging and secret redaction

Use structured, minimal diagnostics. Redact credentials, tokens, authorization headers, secret-bearing URLs, and sensitive config values before any log sink. Add tests for redaction. Never log credentials or secrets.

Current search evaluates declared configuration input names and descriptions without reading values. Token-like inputs are surfaced as sensitive credential requirements; browser session cookies and local filesystem access are elevated concerns. Remote endpoints are disclosed as external dependencies. These classifications indicate review needs, not maliciousness. Unknown authentication is never treated as proof that no credentials are required.

## Threat modelling requirements

For each milestone, identify assets, actors, trust boundaries, attack paths, mitigations, and residual risk. Review malicious registry metadata, typosquatting, compromised publishers, dependency compromise, unsafe package commands, SSRF, OAuth phishing, local config tampering, and downgrade/stale metadata risks. Update this model before enabling new network or write behavior.
