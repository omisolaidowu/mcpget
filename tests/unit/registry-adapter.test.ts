import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeRegistryRecord,
  OfficialRegistryAdapter,
  parseRegistryPage,
  RegistryError,
} from "../../src/discovery/registry/official-registry-adapter.js";

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/registry-page.json", import.meta.url), "utf8"),
) as unknown;

describe("OfficialRegistryAdapter", () => {
  it("requests the documented latest-version name search and normalizes candidates", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const adapter = new OfficialRegistryAdapter({ fetchImpl: fetchImpl as typeof fetch });
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
        packages: [{ registryType: "npm", identifier: "@linear/server", version: "1.2.0", runtimeHint: "npx" }],
        configurationInputs: [{
          name: "LINEAR_API_KEY",
          required: true,
          secret: true,
          description: "Token for connecting to a workspace.",
          deployment: "local-package",
        }],
      },
    });
    expect(candidates[0]?.sourceRecordUrl).toContain("io.github.linear%2Fmcp-server");
    expect(JSON.stringify(candidates)).not.toContain("must-never-be-normalized");
  });

  it("supports empty responses", async () => {
    const adapter = new OfficialRegistryAdapter({
      fetchImpl: (async () => new Response(JSON.stringify({ servers: [] }))) as typeof fetch,
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
    await expect(adapter.searchByName("linear")).resolves.toEqual([]);
    expect(new URL(urls[1]!).searchParams.get("cursor")).toBe("opaque:/cursor?x");
  });

  it("rejects malformed response envelopes and records unsupported terms", () => {
    expect(() => parseRegistryPage({ nope: [] })).toThrow(RegistryError);
    expect(() => parseRegistryPage({ servers: [], metadata: "bad" })).toThrow(RegistryError);
    expect(normalizeRegistryRecord({ server: { title: "no name" } })).toBeUndefined();
  });

  it("preserves missing optional metadata as absent", () => {
    const candidate = normalizeRegistryRecord({ server: { name: "io.example/basic" } });
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

  it("redacts credential-like query parameters and fragments from registry URLs", () => {
    const candidate = normalizeRegistryRecord({
      server: {
        name: "io.example/remote",
        websiteUrl: "https://example.com/docs?access_token=private&tab=setup#session=private",
        remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp?api_key=private" }],
      },
    });
    expect(candidate?.websiteUrl).toBe("https://example.com/docs?tab=setup");
    expect(candidate?.operational.remoteEndpoints).toEqual(["https://mcp.example.com/mcp"]);
    expect(JSON.stringify(candidate)).not.toContain("private");
  });

  it("loads a server detail record by encoded identifier", async () => {
    const record = (fixture as { servers: unknown[] }).servers[0];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(record)));
    const adapter = new OfficialRegistryAdapter({ fetchImpl: fetchImpl as typeof fetch });
    const candidate = await adapter.getByIdentifier("io.github.linear/mcp-server");
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).pathname).toBe(
      "/v0.1/servers/io.github.linear%2Fmcp-server/versions/latest",
    );
    expect(candidate.registryIdentifier).toBe("io.github.linear/mcp-server");
  });

  it("maps HTTP failures and rate limits to actionable errors", async () => {
    const adapter = new OfficialRegistryAdapter({
      fetchImpl: (async () => new Response("", { status: 429 })) as typeof fetch,
    });
    await expect(adapter.searchByName("linear")).rejects.toThrow(/rate limiting/);
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
    await expect(network.searchByName("linear")).rejects.toThrow(/Could not reach/);
  });

  it("enforces the registry's documented three-character query minimum", async () => {
    const adapter = new OfficialRegistryAdapter();
    await expect(adapter.searchByName("ab")).rejects.toThrow(/at least 3 characters/);
  });
});
