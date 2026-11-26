import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeRegistryRecord,
  OfficialRegistryAdapter,
  parseRegistryPage,
  RegistryError,
} from "../../src/discovery/registry/official-registry-adapter.js";

const fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/registry-page.json", import.meta.url),
    "utf8",
  ),
) as unknown;

describe("OfficialRegistryAdapter", () => {
  it("requests the documented latest-version name search and normalizes candidates", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(fixture), { status: 200 }),
    );
    const adapter = new OfficialRegistryAdapter({
      fetchImpl: fetchImpl as typeof fetch,
    });
    const candidates = await adapter.searchByName("linear");
    const requestUrl = new URL(String(fetchImpl.mock.calls[0]?.[0]));

    expect(requestUrl.pathname).toBe("/v0.1/servers");
    expect(requestUrl.searchParams.get("search")).toBe("linear");
    expect(requestUrl.searchParams.get("version")).toBe("latest");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      name: "io.github.linear/mcp-server",
      version: "1.2.0",
      repositoryUrl: "https://github.com/linear/mcp-server",
      websiteUrl: "https://linear.app/developers",
      registryStatus: "active",
      operational: {
        transports: ["stdio", "streamable-http"],
        remoteEndpoints: ["https://linear.app/mcp"],
        packages: [
          {
            registryType: "npm",
            identifier: "@linear/server",
            version: "1.2.0",
            runtimeHint: "npx",
          },
        ],
        configurationInputs: [
          {
            name: "LINEAR_API_KEY",
            required: true,
            secret: true,
            description: "Token for connecting to a workspace.",
            deployment: "local-package",
          },
        ],
      },
    });
    expect(candidates[0]?.sourceRecordUrl).toContain(
      "io.github.linear%2Fmcp-server",
    );
    expect(JSON.stringify(candidates)).not.toContain(
      "must-never-be-normalized",
    );
  });

  it("supports empty responses", async () => {
    const adapter = new OfficialRegistryAdapter({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ servers: [] }))) as typeof fetch,
    });
    await expect(adapter.searchByName("linear")).resolves.toEqual([]);
  });

  it("follows opaque cursors and deduplicates candidates", async () => {
    const first = { servers: [], metadata: { nextCursor: "opaque:/cursor?x" } };
    const second = { servers: [], metadata: { nextCursor: null } };
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(urls.length === 1 ? first : second));
    }) as typeof fetch;
    const adapter = new OfficialRegistryAdapter({ fetchImpl });
    await expect(
      adapter.searchByNameWithMetadata("linear"),
    ).resolves.toMatchObject({
      candidates: [],
      status: "complete",
      terminationReason: "cursor_exhausted",
      pagesFetched: 2,
      safetyLimitReached: false,
    });
    expect(new URL(urls[1]!).searchParams.get("cursor")).toBe(
      "opaque:/cursor?x",
    );
  });

  it("returns deduplicated partial results exactly at the page safety limit", async () => {
    let pagesFetched = 0;
    const record = (fixture as { servers: unknown[] }).servers[0];
    const adapter = new OfficialRegistryAdapter({
      fetchImpl: (async () => {
        pagesFetched += 1;
        return new Response(
          JSON.stringify({
            servers: [record],
            metadata: { nextCursor: `cursor-${pagesFetched}` },
          }),
        );
      }) as typeof fetch,
    });

    const result = await adapter.searchByNameWithMetadata("linear");

    expect(pagesFetched).toBe(100);
    expect(result).toMatchObject({
      status: "partial",
      terminationReason: "page_limit_reached",
      pagesFetched: 100,
      safetyLimitReached: true,
    });
    expect(result.candidates).toHaveLength(1);
  });

  it("keeps the legacy array search from hiding a partial Registry result", async () => {
    let page = 0;
    const adapter = new OfficialRegistryAdapter({
      fetchImpl: (async () => {
        page += 1;
        return new Response(
          JSON.stringify({
            servers: [],
            metadata: { nextCursor: `cursor-${page}` },
          }),
        );
      }) as typeof fetch,
    });
    await expect(adapter.searchByName("linear")).rejects.toMatchObject({
      reason: "safety_limit_reached",
    });
    expect(page).toBe(100);
  });

  it("distinguishes repeated cursors, HTTP failures, transport failures, and invalid responses", async () => {
    const repeatedCursor = new OfficialRegistryAdapter({
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            servers: [],
            metadata: { nextCursor: "same-cursor" },
          }),
        )) as typeof fetch,
    });
    await expect(
      repeatedCursor.searchByNameWithMetadata("linear"),
    ).rejects.toMatchObject({ reason: "repeated_cursor" });

    const httpFailure = new OfficialRegistryAdapter({
      fetchImpl: (async () =>
        new Response("", { status: 503 })) as typeof fetch,
    });
    await expect(
      httpFailure.searchByNameWithMetadata("linear"),
    ).rejects.toMatchObject({ reason: "http_failure" });

    const networkFailure = new OfficialRegistryAdapter({
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    await expect(
      networkFailure.searchByNameWithMetadata("linear"),
    ).rejects.toMatchObject({ reason: "transport_failure" });

    const timeout = new OfficialRegistryAdapter({
      fetchImpl: (async () => {
        throw new DOMException("Timed out", "TimeoutError");
      }) as typeof fetch,
    });
    await expect(
      timeout.searchByNameWithMetadata("linear"),
    ).rejects.toMatchObject({ reason: "network_timeout" });

    const invalidResponse = new OfficialRegistryAdapter({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ malformed: true }))) as typeof fetch,
    });
    await expect(
      invalidResponse.searchByNameWithMetadata("linear"),
    ).rejects.toMatchObject({ reason: "invalid_response" });
  });

  it("rejects malformed response envelopes and records unsupported terms", () => {
    expect(() => parseRegistryPage({ nope: [] })).toThrow(RegistryError);
    expect(() => parseRegistryPage({ servers: [], metadata: "bad" })).toThrow(
      RegistryError,
    );
    expect(
      normalizeRegistryRecord({ server: { title: "no name" } }),
    ).toBeUndefined();
  });

  it("preserves missing optional metadata as absent", () => {
    const candidate = normalizeRegistryRecord({
      server: { name: "io.example/basic" },
    });
    expect(candidate).toMatchObject({
      name: "io.example/basic",
      operational: {
        transports: [],
        deploymentModels: [],
        authentication: "Unknown",
        clientCompatibility: "Unknown",
        setupComplexity: "Unknown",
      },
    });
    expect(candidate).not.toHaveProperty("version");
    expect(candidate).not.toHaveProperty("publisherName");
  });

  it("rejects credential-bearing Registry URLs without exposing their values", () => {
    const candidate = normalizeRegistryRecord({
      server: {
        name: "io.example/remote",
        websiteUrl:
          "https://example.com/docs?access_token=private&tab=setup#session=private",
        remotes: [
          {
            type: "streamable-http",
            url: "https://mcp.example.com/mcp?api_key=private",
          },
        ],
      },
    });
    expect(candidate?.websiteUrl).toBeUndefined();
    expect(candidate?.operational.remoteEndpoints).toEqual([]);
    expect(JSON.stringify(candidate)).not.toContain("private");
  });

  it("preserves ordinary endpoint query parameters from Registry metadata", () => {
    const candidate = normalizeRegistryRecord({
      server: {
        name: "io.example/remote",
        remotes: [
          {
            type: "streamable-http",
            url: "https://mcp.example.com/mcp?region=us&mode=read",
          },
        ],
      },
    });
    expect(candidate?.operational.remoteEndpoints).toEqual([
      "https://mcp.example.com/mcp?region=us&mode=read",
    ]);
  });

  it.each([
    "code",
    "code_verifier",
    "access_token",
    "refresh_token",
    "client_secret",
    "token",
    "authorization",
  ])("excludes Registry endpoints containing %s", (parameter) => {
    const secret = "registry-secret-value";
    const candidate = normalizeRegistryRecord({
      server: {
        name: "io.example/remote",
        remotes: [
          {
            type: "streamable-http",
            url: `https://mcp.example.com/mcp?${parameter}=${secret}`,
          },
        ],
      },
    });
    expect(candidate?.operational.remoteEndpoints).toEqual([]);
    expect(JSON.stringify(candidate)).not.toContain(secret);
  });

  it("excludes Registry endpoints containing user-info or fragments", () => {
    const secret = "registry-url-secret";
    const candidate = normalizeRegistryRecord({
      server: {
        name: "io.example/remote",
        remotes: [
          {
            type: "streamable-http",
            url: `https://user:${secret}@mcp.example.com/mcp`,
          },
          {
            type: "streamable-http",
            url: `https://mcp.example.com/mcp#access_token=${secret}`,
          },
        ],
      },
    });
    expect(candidate?.operational.remoteEndpoints).toEqual([]);
    expect(JSON.stringify(candidate)).not.toContain(secret);
  });

  it("filters non-HTTPS and local/private remote endpoints from registry data", () => {
    const candidate = normalizeRegistryRecord({
      server: {
        name: "io.example/remote",
        remotes: [
          { type: "streamable-http", url: "http://mcp.example.com/mcp" },
          { type: "streamable-http", url: "https://127.0.0.1/mcp" },
          { type: "streamable-http", url: "https://mcp.example.com/mcp" },
        ],
      },
    });
    expect(candidate?.operational.remoteEndpoints).toEqual([
      "https://mcp.example.com/mcp",
    ]);
  });

  it("loads a server detail record by encoded identifier", async () => {
    const record = (fixture as { servers: unknown[] }).servers[0];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(record)));
    const adapter = new OfficialRegistryAdapter({
      fetchImpl: fetchImpl as typeof fetch,
    });
    const candidate = await adapter.getByIdentifier(
      "io.github.linear/mcp-server",
    );
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).pathname).toBe(
      "/v0.1/servers/io.github.linear%2Fmcp-server/versions/latest",
    );
    expect(candidate.registryIdentifier).toBe("io.github.linear/mcp-server");
  });

  it("maps HTTP failures and rate limits to actionable errors", async () => {
    const adapter = new OfficialRegistryAdapter({
      fetchImpl: (async () =>
        new Response("", { status: 429 })) as typeof fetch,
    });
    await expect(adapter.searchByName("linear")).rejects.toThrow(
      /rate limiting/,
    );
  });

  it("reports timeouts and network errors", async () => {
    const timeout = new OfficialRegistryAdapter({
      fetchImpl: (async () => {
        throw new DOMException("Timed out", "TimeoutError");
      }) as typeof fetch,
    });
    await expect(timeout.searchByName("linear")).rejects.toThrow(/timed out/);
    const network = new OfficialRegistryAdapter({
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    await expect(network.searchByName("linear")).rejects.toThrow(
      /Could not reach/,
    );
  });

  it("enforces the registry's documented three-character query minimum", async () => {
    const adapter = new OfficialRegistryAdapter();
    await expect(adapter.searchByName("ab")).rejects.toThrow(
      /at least 3 characters/,
    );
  });
});
