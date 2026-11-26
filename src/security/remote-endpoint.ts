import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { domainToASCII } from "node:url";
import { Agent } from "undici";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface RemoteEndpointPolicyOptions {
  resolveHost?: HostResolver;
  dnsTimeoutMs?: number;
}

export interface ValidatedRemoteEndpoint {
  url: URL;
  hostname: string;
  addresses: ResolvedAddress[];
  trust: "public_https";
}

const dnsTimeoutDefaultMs = 3_000;
const deniedIpv4 = new BlockList();
const deniedIpv6 = new BlockList();
const publicIpv6 = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  deniedIpv4.addSubnet(network, prefix, "ipv4");
}
deniedIpv4.addAddress("255.255.255.255", "ipv4");
publicIpv6.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const) {
  deniedIpv6.addSubnet(network, prefix, "ipv6");
}

const localHostnameSuffixes = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".test",
  ".invalid",
  ".example",
  ".onion",
  ".svc",
  ".cluster.local",
];
const cloudMetadataHostnames = new Set([
  "metadata",
  "metadata.google",
  "metadata.google.internal",
  "metadata.azure.internal",
  "instance-data.ec2.internal",
]);

export class RemoteEndpointSecurityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RemoteEndpointSecurityError";
  }
}

export function hasSensitiveUrlQuery(url: URL): boolean {
  return hasSensitiveParameterNames(url.searchParams.keys());
}

export function hasCredentialLikeUrlFragment(url: URL): boolean {
  return hasSensitiveParameterNames(
    new URLSearchParams(url.hash.slice(1)).keys(),
  );
}

export function redactEndpointCredentials(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return "[invalid endpoint URL]";
  }

  let redacted = false;
  if (url.username) {
    url.username = "REDACTED";
    redacted = true;
  }
  if (url.password) {
    url.password = "REDACTED";
    redacted = true;
  }
  for (const name of new Set(url.searchParams.keys())) {
    if (isSensitiveParameterName(name)) {
      url.searchParams.set(name, "REDACTED");
      redacted = true;
    }
  }
  if (url.hash) {
    const fragment = new URLSearchParams(url.hash.slice(1));
    let fragmentRedacted = false;
    for (const name of new Set(fragment.keys())) {
      if (isSensitiveParameterName(name)) {
        fragment.set(name, "REDACTED");
        fragmentRedacted = true;
      }
    }
    if (fragmentRedacted) {
      url.hash = fragment.toString();
      redacted = true;
    }
  }
  return redacted ? url.toString() : input;
}

export function parsePublicHttpsEndpoint(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new RemoteEndpointSecurityError(
      "The remote MCP endpoint is not a valid URL.",
    );
  }
  if (url.protocol !== "https:")
    throw new RemoteEndpointSecurityError(
      "Remote MCP endpoints must use HTTPS.",
    );
  if (url.username || url.password)
    throw new RemoteEndpointSecurityError(
      "Remote MCP endpoint URLs cannot contain embedded credentials.",
    );
  if (hasSensitiveUrlQuery(url))
    throw new RemoteEndpointSecurityError(
      "Remote MCP endpoint URLs cannot contain credential-bearing query parameters.",
    );
  if (url.hash)
    throw new RemoteEndpointSecurityError(
      "Remote MCP endpoint URLs cannot contain fragments.",
    );
  const hostname = normalizeHostname(url.hostname);
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname))
      throw new RemoteEndpointSecurityError(
        "The remote MCP endpoint resolves to a loopback, private, reserved, or local-network address.",
      );
    return url;
  }
  if (
    hostname.length > 253 ||
    !hostname.includes(".") ||
    !hostname
      .split(".")
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= 63 &&
          /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label),
      ) ||
    localHostnameSuffixes.some((suffix) => hostname.endsWith(suffix)) ||
    cloudMetadataHostnames.has(hostname)
  ) {
    throw new RemoteEndpointSecurityError(
      "Remote MCP endpoints must use a public DNS hostname, not a local or reserved hostname.",
    );
  }
  return url;
}

export async function validatePublicHttpsEndpoint(
  input: string | URL,
  options: RemoteEndpointPolicyOptions = {},
): Promise<ValidatedRemoteEndpoint> {
  const url = parsePublicHttpsEndpoint(input);
  const hostname = normalizeHostname(url.hostname);
  const literalFamily = isIP(hostname);
  let addresses: ResolvedAddress[];
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    const resolveHost = options.resolveHost ?? systemResolveHost;
    const dnsTimeoutMs = options.dnsTimeoutMs ?? dnsTimeoutDefaultMs;
    if (!Number.isFinite(dnsTimeoutMs) || dnsTimeoutMs <= 0)
      throw new RangeError(
        "DNS resolution timeout must be a positive finite number.",
      );
    try {
      addresses = await withTimeout(resolveHost(hostname), dnsTimeoutMs);
    } catch (error) {
      if (error instanceof RemoteEndpointSecurityError) throw error;
      throw new RemoteEndpointSecurityError(
        "The remote MCP endpoint hostname could not be resolved safely.",
        { cause: error },
      );
    }
  }
  if (!addresses.length)
    throw new RemoteEndpointSecurityError(
      "The remote MCP endpoint hostname returned no addresses.",
    );
  for (const resolved of addresses) {
    if (
      isIP(resolved.address) !== resolved.family ||
      !isPublicAddress(resolved.address)
    ) {
      throw new RemoteEndpointSecurityError(
        "The remote MCP endpoint hostname resolves to a loopback, private, reserved, or local-network address.",
      );
    }
  }
  return { url, hostname, addresses, trust: "public_https" };
}

function hasSensitiveParameterNames(names: Iterable<string>): boolean {
  for (const name of names) if (isSensitiveParameterName(name)) return true;
  return false;
}

function isSensitiveParameterName(name: string): boolean {
  const normalized = name
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/[-.]/g, "_")
    .toLowerCase();
  return (
    /^(?:code|code_verifier|oauth_code|authorization)$/.test(normalized) ||
    /(?:^|_)(?:token|secret|key|auth|password|credential|session|cookie|signature|assertion|bearer)(?:_|$)/.test(
      normalized,
    )
  );
}

export function createPinnedLookup(
  addresses: ResolvedAddress[],
  expectedHostname?: string,
): LookupFunction {
  return (hostname, options, callback) => {
    const requestedFamily =
      typeof options.family === "number"
        ? options.family
        : options.family === "IPv4"
          ? 4
          : options.family === "IPv6"
            ? 6
            : undefined;
    if (
      expectedHostname &&
      normalizeHostname(hostname) !== normalizeHostname(expectedHostname)
    ) {
      const error = Object.assign(
        new Error(
          "The connection hostname does not match the validated endpoint.",
        ),
        { code: "ENOTFOUND" },
      ) as NodeJS.ErrnoException;
      callback(error, "", requestedFamily);
      return;
    }
    const compatible = addresses.filter(
      (address) => !requestedFamily || address.family === requestedFamily,
    );
    if (!compatible.length) {
      const error = Object.assign(
        new Error("The validated endpoint has no address for this family."),
        { code: "ENOTFOUND" },
      ) as NodeJS.ErrnoException;
      callback(error, "", requestedFamily);
      return;
    }
    if (options.all) {
      callback(null, compatible);
      return;
    }
    const first = compatible[0]!;
    callback(null, first.address, first.family);
  };
}

export function createSecureRemoteFetch(
  options: RemoteEndpointPolicyOptions & { fetchImpl?: typeof fetch } = {},
): typeof fetch {
  const baseFetch = options.fetchImpl ?? fetch;
  return async (input, init) => {
    const inputUrl = input instanceof Request ? input.url : String(input);
    const validated = await validatePublicHttpsEndpoint(inputUrl, options);
    const dispatcher = new Agent({
      connect: {
        lookup: createPinnedLookup(validated.addresses, validated.hostname),
      },
      connections: 1,
      pipelining: 0,
    });
    try {
      const requestInit: RequestInit & { dispatcher: Agent } = {
        ...init,
        redirect: "manual",
        dispatcher,
      };
      const response = await baseFetch(input, requestInit);
      return attachDispatcherLifetime(response, dispatcher);
    } catch (error) {
      await dispatcher.close();
      throw error;
    }
  };
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !deniedIpv4.check(address, "ipv4");
  if (family !== 6) return false;
  const mappedIpv4 = ipv4FromMappedIpv6(address);
  if (mappedIpv4) return isPublicAddress(mappedIpv4);
  return (
    publicIpv6.check(address, "ipv6") && !deniedIpv6.check(address, "ipv6")
  );
}

function normalizeHostname(value: string): string {
  const hostname = value.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const ascii = domainToASCII(hostname).toLowerCase();
  if (!ascii)
    throw new RemoteEndpointSecurityError(
      "The remote MCP endpoint hostname is invalid.",
    );
  return ascii;
}

function ipv4FromMappedIpv6(address: string): string | undefined {
  const groups = ipv6Groups(address);
  if (
    !groups ||
    groups.slice(0, 5).some((group) => group !== 0) ||
    groups[5] !== 0xffff
  )
    return undefined;
  const high = groups[6]!;
  const low = groups[7]!;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function ipv6Groups(input: string): number[] | undefined {
  let value = input.toLowerCase();
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    const octets = value
      .slice(separator + 1)
      .split(".")
      .map(Number);
    if (
      octets.length !== 4 ||
      octets.some(
        (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255,
      )
    )
      return undefined;
    value = `${value.slice(0, separator)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return undefined;
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  )
    return undefined;
  return groups.map((group) => Number.parseInt(group, 16));
}

async function systemResolveHost(hostname: string): Promise<ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new RemoteEndpointSecurityError(
                "Remote MCP endpoint DNS resolution timed out.",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function attachDispatcherLifetime(
  response: Response,
  dispatcher: Agent,
): Response {
  let body: ReadableStream<Uint8Array> | null = null;
  let closed = false;
  const closeDispatcher = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await dispatcher.close();
  };
  if (response.body) {
    const reader = response.body.getReader();
    body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            controller.close();
            await closeDispatcher();
            reader.releaseLock();
          } else {
            controller.enqueue(result.value);
          }
        } catch (error) {
          controller.error(error);
          await closeDispatcher();
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
        reader.releaseLock();
        await closeDispatcher();
      },
    });
  } else {
    void closeDispatcher();
  }
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperty(wrapped, "url", { value: response.url });
  Object.defineProperty(wrapped, "redirected", { value: response.redirected });
  return wrapped;
}
