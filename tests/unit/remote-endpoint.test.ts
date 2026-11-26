import { describe, expect, it, vi } from "vitest";
import {
  createPinnedLookup,
  createSecureRemoteFetch,
  parsePublicHttpsEndpoint,
  RemoteEndpointSecurityError,
  validatePublicHttpsEndpoint,
  type HostResolver,
} from "../../src/security/remote-endpoint.js";

const publicAddress = { address: "93.184.216.34", family: 4 };
const publicResolver: HostResolver = async () => [publicAddress];

describe("remote endpoint destination policy", () => {
  it.each([
    "code",
    "code_verifier",
    "access_token",
    "refresh_token",
    "client_secret",
    "token",
    "authorization",
    "api_key",
  ])(
    "rejects credential-bearing endpoint query parameter %s without echoing its value",
    (name) => {
      const secret = "secret-value-never-echo";
      expect(() =>
        parsePublicHttpsEndpoint(
          `https://mcp.example.com/mcp?${name}=${secret}&page=2`,
        ),
      ).toThrow(/credential-bearing query parameters/i);
      try {
        parsePublicHttpsEndpoint(
          `https://mcp.example.com/mcp?${name}=${secret}&page=2`,
        );
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        expect(error.message).not.toContain(secret);
      }
    },
  );

  it("rejects URL user-info and fragments while preserving ordinary query values", () => {
    expect(() =>
      parsePublicHttpsEndpoint("https://user:private@mcp.example.com/mcp"),
    ).toThrow(/embedded credentials/i);
    expect(() =>
      parsePublicHttpsEndpoint(
        "https://mcp.example.com/mcp#access_token=secret-value",
      ),
    ).toThrow(/fragments/i);
    expect(
      parsePublicHttpsEndpoint("https://mcp.example.com/mcp?page=2&mode=read")
        .search,
    ).toBe("?page=2&mode=read");
  });

  it("accepts HTTPS public IPs and hostnames with public DNS answers", async () => {
    expect(parsePublicHttpsEndpoint("https://93.184.216.34/mcp").protocol).toBe(
      "https:",
    );
    await expect(
      validatePublicHttpsEndpoint("https://mcp.example.com/mcp", {
        resolveHost: publicResolver,
      }),
    ).resolves.toMatchObject({
      hostname: "mcp.example.com",
      addresses: [publicAddress],
      trust: "public_https",
    });
  });

  it.each([
    ["HTTP", "http://mcp.example.com/mcp"],
    ["unspecified IPv4", "https://0.0.0.0/mcp"],
    ["loopback IPv4", "https://127.0.0.1/mcp"],
    ["loopback IPv6", "https://[::1]/mcp"],
    ["private IPv4", "https://10.2.3.4/mcp"],
    ["unique-local IPv6", "https://[fc00::1]/mcp"],
    ["link-local IPv4", "https://169.254.10.1/mcp"],
    ["link-local IPv6", "https://[fe80::1]/mcp"],
    ["multicast IPv4", "https://224.0.0.1/mcp"],
    ["multicast IPv6", "https://[ff02::1]/mcp"],
    ["unspecified IPv6", "https://[::]/mcp"],
    ["IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/mcp"],
    ["localhost hostname", "https://localhost/mcp"],
    ["local-network hostname", "https://mcp.internal/mcp"],
    ["cloud metadata hostname", "https://metadata.google.internal/mcp"],
  ])("rejects %s destinations", (_label, endpoint) => {
    expect(() => parsePublicHttpsEndpoint(endpoint)).toThrow(
      RemoteEndpointSecurityError,
    );
  });

  it("rejects private and mixed public/private DNS answers", async () => {
    const resolver: HostResolver = async () => [
      publicAddress,
      { address: "192.168.1.10", family: 4 },
    ];
    await expect(
      validatePublicHttpsEndpoint("https://mcp.example.com/mcp", {
        resolveHost: resolver,
      }),
    ).rejects.toThrow(/resolves to a loopback, private/i);

    await expect(
      validatePublicHttpsEndpoint("https://mcp.example.com/mcp", {
        resolveHost: async () => [{ address: "2001:db8::1", family: 6 }],
      }),
    ).rejects.toThrow(/resolves to a loopback, private/i);
  });

  it("fails closed on DNS failures and timeouts", async () => {
    await expect(
      validatePublicHttpsEndpoint("https://mcp.example.com/mcp", {
        resolveHost: async () => {
          throw new Error("controlled DNS failure");
        },
      }),
    ).rejects.toThrow(/could not be resolved safely/i);
    await expect(
      validatePublicHttpsEndpoint("https://mcp.example.com/mcp", {
        resolveHost: () => new Promise(() => {}),
        dnsTimeoutMs: 5,
      }),
    ).rejects.toThrow(/DNS resolution timed out/i);
  });
});

describe("pinned remote fetch", () => {
  it("uses validated addresses and rejects a rebinding result before fetching", async () => {
    let lookups = 0;
    const resolver: HostResolver = async () => {
      lookups += 1;
      return lookups === 1
        ? [publicAddress]
        : [{ address: "10.0.0.8", family: 4 }];
    };
    await validatePublicHttpsEndpoint("https://mcp.example.com/mcp", {
      resolveHost: resolver,
    });

    const fetchImpl: typeof fetch = async () =>
      new Response(null, { status: 200 });
    const secureFetch = createSecureRemoteFetch({
      resolveHost: resolver,
      fetchImpl,
    });
    await expect(secureFetch("https://mcp.example.com/mcp")).rejects.toThrow(
      /resolves to a loopback, private/i,
    );
    expect(lookups).toBe(2);
  });

  it("pins lookup to the validated host and rejects mismatched hostnames", () => {
    const lookup = createPinnedLookup([publicAddress], "mcp.example.com");
    const result = vi.fn();
    lookup("mcp.example.com", {}, result);
    expect(result).toHaveBeenLastCalledWith(null, publicAddress.address, 4);

    const rejected = vi.fn();
    lookup("other.example.com", {}, rejected);
    expect(rejected.mock.calls[0]?.[0]).toMatchObject({ code: "ENOTFOUND" });
  });

  it("forces manual redirects and never forwards a redirect destination itself", async () => {
    const requested: string[] = [];
    let requestInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      requested.push(input instanceof Request ? input.url : String(input));
      requestInit = init;
      return new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
      });
    };
    const secureFetch = createSecureRemoteFetch({
      resolveHost: publicResolver,
      fetchImpl,
    });
    const response = await secureFetch("https://mcp.example.com/mcp", {
      headers: { authorization: "Bearer test-secret" },
    });
    expect(response.status).toBe(302);
    expect(requested).toEqual(["https://mcp.example.com/mcp"]);
    expect(requestInit?.redirect).toBe("manual");
    expect(JSON.stringify(requested)).not.toContain("test-secret");
    await response.body?.cancel();
  });

  it("does not automatically follow downgrade redirects", async () => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requested.push(input instanceof Request ? input.url : String(input));
      return new Response(null, {
        status: 301,
        headers: { location: "http://mcp.example.com/mcp" },
      });
    };
    const secureFetch = createSecureRemoteFetch({
      resolveHost: publicResolver,
      fetchImpl,
    });
    const response = await secureFetch("https://mcp.example.com/mcp");
    expect(response.status).toBe(301);
    expect(requested).toEqual(["https://mcp.example.com/mcp"]);
    await response.body?.cancel();
    await expect(secureFetch("http://mcp.example.com/mcp")).rejects.toThrow(
      /must use HTTPS/i,
    );
  });
});
