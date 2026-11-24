import { describe, expect, it } from "vitest";
import { resolveServiceIdentity, UrlResolutionError } from "../../src/discovery/url-resolver.js";

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

  it("maps the known Notion URL and shorthand variants to one service identity", () => {
    const variants = [
      resolveServiceIdentity("notion"),
      resolveServiceIdentity("notion.com"),
      resolveServiceIdentity("https://notion.com"),
      resolveServiceIdentity("https://www.notion.so/workspace"),
    ];
    expect(new Set(variants.map((identity) => identity.canonicalName))).toEqual(new Set(["Notion"]));
    expect(new Set(variants.map((identity) => identity.domain))).toEqual(new Set(["notion.so"]));
    expect(new Set(variants.map((identity) => identity.productName))).toEqual(new Set(["notion"]));
  });

  it("preserves meaningful tenant subdomains for private suffixes", () => {
    expect(resolveServiceIdentity("workspace.atlassian.net").domain).toBe("atlassian.net");
    expect(resolveServiceIdentity("workspace.atlassian.net").hostname).toBe("workspace.atlassian.net");
    expect(resolveServiceIdentity("workspace.atlassian.net").domains).toContain("workspace.atlassian.net");
  });

  it.each(["", "   ", "not a url", "https://bad..example", "javascript:alert(1)", "ftp://example.com"]) (
    "rejects invalid or unsupported input %s",
    (input) => expect(() => resolveServiceIdentity(input)).toThrow(UrlResolutionError),
  );

  it.each(["localhost", "127.0.0.1", "http://[::1]"]) (
    "identifies local or IP host %s",
    (input) => expect(resolveServiceIdentity(input).isLocalOrIp).toBe(true),
  );

  it("rejects credentials embedded in the URL", () => {
    expect(() => resolveServiceIdentity("https://user:secret@example.com")).toThrow(/credentials/);
  });
});
