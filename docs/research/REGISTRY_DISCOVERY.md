# Registry discovery research

## Evidence status

Verified against the Official Registry API reference and OpenAPI specification on 2026-11-23. The MCPGet adapter uses the read-only list/search API; it does not publish, authenticate, install, execute, or connect to returned servers. Official documentation: [Official Registry API](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md) and [API OpenAPI specification](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/openapi.yaml).

## Official MCP Registry

MCPGet queries `https://registry.modelcontextprotocol.io/v0.1/servers`. The official docs describe the API as a public registry of MCP server metadata. Presence in this registry does not establish that a server is safe or endorsed by a SaaS vendor.

## Registry API

The adapter calls `GET /v0.1/servers` with `search=<product-label>`, `version=latest`, and `limit=100`; subsequent requests pass the returned opaque `metadata.nextCursor` unchanged and retain the same filters. The response envelope contains a `servers` array of records with a nested `server` object and optional `_meta`. The adapter normalizes documented name, title, description, version, repository URL, website URL, package and remote transport fields, package/runtime references, remote endpoint URLs, declared configuration inputs, and Registry lifecycle metadata when present. In the current schema package transports are under `packages[].transport.type`, while remote transports are at `remotes[].type`; their URL is `remotes[].url`. Malformed records without a server name are skipped; a malformed response envelope is an error.

For inspection the adapter uses `GET /v0.1/servers/{url-encoded-server-name}/versions/latest`, which the API reference documents for a known server name. This is a Registry API request; MCPGet does not follow repository, website, or remote MCP endpoint URLs.

The Official Registry documents `search` as a case-insensitive substring match over server names only. Nonempty search terms must contain at least three Unicode characters; shorter terms receive HTTP 422. Therefore MCPGet derives the query from the registrable service domain and its leading product label. It cannot use the endpoint to discover a server whose name does not contain that label, even if its description or repository refers to the service. An input label shorter than three characters is reported as unsupported rather than replaced with an unfiltered full-registry scan.

The API reference does not specify a request rate limit. MCPGet uses a bounded request timeout and reports HTTP 429 without retrying. Registry pagination is cursor based; the adapter detects repeated cursors and applies a 100-page safety ceiling. Version filtering uses `latest`, as documented; the API notes that `latest` does not necessarily mean active, so this first milestone does not claim that candidates are operational.

## Namespace verification

Registry publisher namespaces have verification mechanisms documented by the registry (GitHub-based and domain-based publishing flows). The search response alone does not establish that the publisher is the SaaS vendor represented by the input URL. MCPGet therefore labels publisher verification as unverified and does not infer officialness from a matching name, description, registry listing, or repository URL.

## Server metadata and versions

The current adapter uses fields only when they have the expected types. Registry identifier and its namespace are kept separate from title, repository, website, and publisher identity. Package `registryType`, `identifier`, `version`, and `runtimeHint` are presented as Registry-provided package/runtime hints; no package is installed or executed. Package `environmentVariables` and remote `variables` can declare names, required status, secret status, and descriptions. Values are never read or emitted. A declared input does not establish an authentication protocol, so authentication stays `Unknown`. Likewise, Registry metadata does not establish client compatibility. Registry result provenance is retained as the official Registry source and a detail API URL assembled from the returned server name and version.

## Pagination

The Registry uses opaque cursor pagination through `metadata.nextCursor`. Its documentation says to keep filters unchanged on subsequent pages. Results may contain multiple versions without a version filter; MCPGet requests `version=latest`. The API orders names and version strings lexically. The reference exposes an optional `limit` but does not publish a maximum in the cited contract; MCPGet requests 100 per page and does not rely on ordering for relevance ranking.

## Registry limitations

The key discovery limitation is search scope: it matches server names, not service domains or descriptive metadata. Coverage, freshness, moderation, availability, and data quality may vary. The API reference does not specify a numeric rate limit. Registry metadata is not a security audit or proof of vendor ownership.

## Community directory opportunities

Community-maintained directories may improve coverage, but vary in governance and quality. Future adapters should label source type and confidence, retain links, deduplicate carefully, and avoid presenting community inclusion as endorsement.

## Domain-first discovery

Current behavior uses `tldts` and an explicit known-product alias map to normalize `notion`, `notion.com`, and `notion.so` to the same Notion service identity. Notion's official documentation references both `notion.com` and `notion.so` for its service ([network control guidance](https://www.notion.com/help/network-control), [account settings](https://www.notion.com/help/account-settings)). Other hostnames retain their parsed registrable domain and supplied hostname; meaningful subdomains are retained as identity/domain evidence rather than silently discarded. Search uses the canonical product label. The Registry response is evaluated in separate dimensions: relevance (direct, specialized, related, unrelated), match confidence (high, medium, low), and trust (vendor verified, publisher verified, community maintained, unverified, insufficient evidence). Search records currently do not expose independent publisher verification, so the evaluator never promotes a vendor or publisher to verified and does not assume every entry is community maintained.

### Matching audit findings

The earlier matcher treated the short service label (`notion`) as an exact domain-like substring, which inflated confidence for `notion` searches. `notion.com` did not receive that same shortcut and was mostly scored from product-name evidence, producing lower confidence for nearly identical Registry records. The current resolver maps known Notion aliases to one canonical identity, and the evaluator requires corroborating evidence before a domain match produces high confidence. The earlier matcher also searched the full Registry identifier, allowing publisher namespace text to create matches unrelated to the server itself. The evaluator now treats the server slug separately from the namespace. Narrow Notion URL-shape tools are classified as specialized, while mathematical Linear Programming matches are classified as unrelated.

Broad workflow classification requires multiple inferred operation categories over recognizable SaaS objects. Narrow URL/identifier validation, large-file upload, and bootstrap tools are classified as specialized; clear mathematical linear-programming language is treated as unrelated to Linear SaaS. Publisher descriptions are only claims: inferred capability facets are not verified server behavior. Recommendations consider direct relevance, confidence, breadth of described capabilities, and declared transport metadata; publisher trust does not affect recommendation rank. No candidate URL is fetched.

## Emerging server discovery standards

Monitor MCP specifications and ecosystem discovery proposals for changes to server metadata, registries, transports, and identity. Treat emerging proposals as non-normative until adopted and documented by their maintainers. Recheck current standards at implementation time.
