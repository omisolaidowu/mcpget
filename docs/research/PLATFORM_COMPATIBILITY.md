# Platform compatibility research

## Implemented adapter surface (limited)

| Client | Current MCPGet behavior | Limits |
|---|---|---|
| Claude Desktop | Local stdio JSON adapter; Windows uses a unique active `%LOCALAPPDATA%\Claude-Data\claude_<profile>\claude_desktop_config.json` when detected, otherwise `%APPDATA%\Claude\claude_desktop_config.json`; macOS uses Application Support; Linux uses XDG config | Does not install `.mcpb` extensions or remote connectors; manual secrets unsupported; registration is user scope; actual app reload/connection is separate |
| Cursor | User-level `~/.cursor/mcp.json` JSON adapter; stdio and remote HTTP endpoint entries | Cursor handles OAuth during its own connection flow; MCPGet cannot confirm that later sign-in; app presence not detected |
| OpenAI Codex | User-scope `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) is read and updated directly using TOML parsing | Project `.codex/config.toml` is not modified; Codex CLI is not required for configuration management; it is used only for optional Codex CLI OAuth login; client-held OAuth is not readable by MCPGet; no post-login connection check via Codex |

Current adapter-path and schema references last checked 2026-11-24: [Claude local MCP servers](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop), [Claude remote connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [Cursor MCP configuration locations and schema](https://cursor.com/docs/mcp), [Codex MCP config file and user/project scopes](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). Claude's newer Windows `Claude-Data` profile path is selected from the installed user's local data directory; an explicit `MCPGET_CLAUDE_CONFIG_PATH` override is required if multiple profiles make selection ambiguous. The adapter behavior is narrower than the full product capabilities described by those vendors.

| Client | Operating system support | MCP support | Supported transports | Installation mechanism | Configuration location | Authentication support | Programmatic installation capability | Official documentation | Last verified date | Known limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Desktop | Requires research | Requires research | Requires research | Requires research | Requires research | Requires research | Requires research | Requires research | Unverified | Research official docs per OS and release |
| Cursor | Requires research | Requires research | Requires research | Requires research | Requires research | Requires research | Requires research | Requires research | Unverified | Research official docs per OS and release |
| VS Code | Requires research | Requires research | Requires research | Requires research | Requires research | Requires research | Requires research | Requires research | Unverified | Distinguish built-in and extension behavior |
| Windsurf | Requires research | Requires research | Requires research | Requires research | Requires research | Requires research | Requires research | Requires research | Unverified | Research official docs per OS and release |
| ChatGPT | Requires research | Requires research | Requires research | Requires research | Requires research | Requires research | Requires research | Requires research | Unverified | Clarify product surfaces and account/plan constraints |
| Other MCP-compatible clients | Identify candidates | Requires research | Requires research | Requires research | Requires research | Requires research | Requires research | Requires research | Unverified | Maintain per-client entries once prioritized |

## Research method

For each client, use current official documentation and record page URL, access date, relevant product/version scope, supported OS, transport and auth specifics, installation path or mechanism, and whether automation is documented. Do not infer support from community posts or a similarly named client. Revisit before each client-specific implementation milestone.
