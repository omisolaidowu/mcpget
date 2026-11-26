import { describe, expect, it } from "vitest";
import { discoverByServiceUrl } from "../../src/discovery/search-service.js";
import {
  resolveServiceIdentity,
  UrlResolutionError,
} from "../../src/discovery/url-resolver.js";

describe("resolveServiceIdentity", () => {
  it.each([
    ["https://linear.app", "linear.app"],
    ["https://linear.app/", "linear.app"],
    ["https://linear.app/issues/123?state=open#top", "linear.app"],
    ["www.notion.so/workspace", "notion.so"],
    ["linear.app", "linear.app"],
    ["https://team.example.co.uk/path", "example.co.uk"],
  ])("normalizes %s", (input, domain) => {
    expect(resolveServiceIdentity(input).domain).toBe(domain);
  });

  it("normalizes internationalized hostnames", () => {
    expect(resolveServiceIdentity("münich.de").domain).toBe("xn--mnich-kva.de");
  });

  it.each([
    ["GITHUB.COM", ["github"]],
    ["github.com", ["github"]],
    ["notion.com", ["notion"]],
    ["notion.so", ["notion"]],
    ["www.notion.com", ["notion"]],
    ["www.notion.so", ["notion"]],
    ["linear.app", ["linear"]],
    ["www.slack.com", ["slack"]],
    ["slack.com", ["slack"]],
    ["thunderbit.com", ["thunderbit"]],
    ["www.thunderbit.com", ["thunderbit"]],
    ["zenrows.com", ["zenrows"]],
    ["docs.example.com", ["example"]],
    ["docs.unknown.example", ["docs.unknown.example"]],
    ["github", ["github"]],
    ["notion", ["notion"]],
    ["linear", ["linear"]],
    ["slack", ["slack"]],
  ])("uses the intended Registry search term for %s", (input, terms) => {
    expect(resolveServiceIdentity(input).registrySearchTerms).toEqual(terms);
  });

  it.each([
    ["github.com", "github"],
    ["www.notion.com", "notion"],
    ["linear.app", "linear"],
    ["www.slack.com", "slack"],
    ["thunderbit.com", "thunderbit"],
    ["www.zenrows.com", "zenrows"],
    ["docs.unknown.example", "docs.unknown.example"],
  ])("does not add a broader fallback search for %s", async (input, term) => {
    const searches: string[] = [];
    await discoverByServiceUrl(input, {
      async searchByName(searchTerm) {
        searches.push(searchTerm);
        return [];
      },
    });
    expect(searches).toEqual([term]);
  });

  it("maps the known Notion URL and shorthand variants to one service identity", () => {
    const variants = [
      resolveServiceIdentity("notion"),
      resolveServiceIdentity("notion.com"),
      resolveServiceIdentity("https://notion.com"),
      resolveServiceIdentity("https://www.notion.so/workspace"),
    ];
    expect(new Set(variants.map((identity) => identity.canonicalName))).toEqual(
      new Set(["Notion"]),
    );
    expect(new Set(variants.map((identity) => identity.domain))).toEqual(
      new Set(["notion.so"]),
    );
    expect(new Set(variants.map((identity) => identity.productName))).toEqual(
      new Set(["notion"]),
    );
  });

  it("maps multiple known domains and www variants to their service aliases", () => {
    expect(
      resolveServiceIdentity("https://www.notion.com").registrySearchTerms,
    ).toEqual(["notion"]);
    expect(
      resolveServiceIdentity("https://www.notion.so").registrySearchTerms,
    ).toEqual(["notion"]);
    expect(
      resolveServiceIdentity("https://www.github.com").registrySearchTerms,
    ).toEqual(["github"]);
    expect(
      resolveServiceIdentity("https://www.slack.com").registrySearchTerms,
    ).toEqual(["slack"]);
  });

  it("resolves domain and bare-name variants to equivalent Registry terms", () => {
    const equivalents = [
      ["thunderbit", "thunderbit.com", "www.thunderbit.com"],
      ["zenrows", "zenrows.com", "www.zenrows.com"],
      ["notion", "notion.com", "notion.so", "www.notion.so"],
      ["github", "github.com", "www.github.com"],
      ["linear", "linear.app", "www.linear.app"],
    ];
    for (const [bare, ...domains] of equivalents) {
      const bareTerms = resolveServiceIdentity(bare).registrySearchTerms;
      for (const domain of domains) {
        expect(resolveServiceIdentity(domain).registrySearchTerms).toEqual(
          bareTerms,
        );
      }
    }
  });

  it("does not reinterpret unknown domains as bare registrable names", () => {
    const identity = resolveServiceIdentity("https://docs.unknown.example");
    expect(identity.hostname).toBe("docs.unknown.example");
    expect(identity.domain).toBe("unknown.example");
    expect(identity.registrySearchTerms).toEqual(["docs.unknown.example"]);
  });

  it("preserves meaningful tenant subdomains for private suffixes", () => {
    expect(resolveServiceIdentity("workspace.atlassian.net").domain).toBe(
      "atlassian.net",
    );
    expect(resolveServiceIdentity("workspace.atlassian.net").hostname).toBe(
      "workspace.atlassian.net",
    );
    expect(resolveServiceIdentity("workspace.atlassian.net").domains).toContain(
      "workspace.atlassian.net",
    );
  });

  it.each([
    "",
    "   ",
    "not a url",
    "https://bad..example",
    "javascript:alert(1)",
    "ftp://example.com",
  ])("rejects invalid or unsupported input %s", (input) =>
    expect(() => resolveServiceIdentity(input)).toThrow(UrlResolutionError),
  );

  it.each(["localhost", "127.0.0.1", "http://[::1]"])(
    "identifies local or IP host %s",
    (input) => expect(resolveServiceIdentity(input).isLocalOrIp).toBe(true),
  );

  it("rejects credentials embedded in the URL", () => {
    expect(() =>
      resolveServiceIdentity("https://user:secret@example.com"),
    ).toThrow(/credentials/);
  });
});
