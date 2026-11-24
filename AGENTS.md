# MCPGet development instructions

MCPGet is an open-source TypeScript/Node CLI for MCP discovery and installation. Registry discovery/evaluation and an initial, deliberately limited client configuration installer are implemented. The owner has authorized the product direction in the current implementation brief; do not expand into server execution during install, secure credential handling, or client configuration changes beyond that brief.

## Permanent rules

1. Use TypeScript strict mode.
2. Keep modules small and composable.
3. Separate discovery, verification, compatibility, and installation.
4. Use interfaces for registry and client adapters.
5. Add tests for significant functionality.
6. Preserve existing user configurations.
7. Require explicit confirmation before installation.
8. Never log credentials or secrets.
9. Never execute arbitrary packages silently.
10. Never claim a publisher is official without supporting evidence.
11. Verify current platform documentation before implementing client-specific functionality.
12. Do not invent undocumented API behavior.
13. Keep documentation synchronized with implementation.
14. Implement only the milestone explicitly requested by the project owner.
15. Do not introduce unnecessary dependencies or premature abstractions.

## For each development task

- Inspect existing code first.
- Explain the implementation approach.
- Implement the requested scope.
- Add tests.
- Run tests and type checks.
- Report modified files and outstanding issues.

Do not implement functionality outside the task's explicitly requested scope. Never claim authentication or connection verification when only client configuration has been checked.
