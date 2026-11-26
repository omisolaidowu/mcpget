import type { ServerCandidate } from "../../models/server-candidate.js";
import {
  hasCredentialLikeUrlFragment,
  hasSensitiveUrlQuery,
  parsePublicHttpsEndpoint,
} from "../../security/remote-endpoint.js";

const REGISTRY_BASE_URL = "https://registry.modelcontextprotocol.io";
const REGISTRY_SERVERS_PATH = "/v0.1/servers";
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

export type RegistryErrorReason =
  | "invalid_query"
  | "repeated_cursor"
  | "http_failure"
  | "network_timeout"
  | "transport_failure"
  | "invalid_response"
  | "safety_limit_reached";

export class RegistryError extends Error {
  constructor(
    message: string,
    options?: ErrorOptions,
    readonly reason: RegistryErrorReason = "invalid_response",
  ) {
    super(message, options);
    this.name = "RegistryError";
  }
}

export interface RegistrySearchResult {
  candidates: ServerCandidate[];
  status: "complete" | "partial";
  terminationReason: "cursor_exhausted" | "page_limit_reached";
  pagesFetched: number;
  safetyLimitReached: boolean;
}

interface RegistryAdapterOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

interface RegistryPage {
  servers: unknown[];
  nextCursor?: string;
}

export class OfficialRegistryAdapter {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: RegistryAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError(
        "Registry request timeout must be a positive finite number.",
      );
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? REGISTRY_BASE_URL;
  }

  async searchByName(name: string): Promise<ServerCandidate[]> {
    const result = await this.searchByNameWithMetadata(name);
    if (result.safetyLimitReached) {
      throw new RegistryError(
        `Registry search exceeded the safety limit of ${MAX_PAGES} pages. Try a more specific service name.`,
        undefined,
        "safety_limit_reached",
      );
    }
    return result.candidates;
  }

  async searchByNameWithMetadata(name: string): Promise<RegistrySearchResult> {
    const search = name.trim();
    if ([...search].length < 3) {
      throw new RegistryError(
        "The Official MCP Registry requires search terms to contain at least 3 characters. This service name is too short to search directly.",
        undefined,
        "invalid_query",
      );
    }

    const results: ServerCandidate[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pagesFetched = 0;

    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page = await this.fetchPage(search, cursor);
      pagesFetched += 1;
      for (const record of page.servers) {
        const candidate = normalizeRegistryRecord(record, this.baseUrl);
        if (candidate) results.push(candidate);
      }

      if (!page.nextCursor) {
        return {
          candidates: deduplicateCandidates(results),
          status: "complete",
          terminationReason: "cursor_exhausted",
          pagesFetched,
          safetyLimitReached: false,
        };
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new RegistryError(
          "The registry returned a repeated pagination cursor.",
          undefined,
          "repeated_cursor",
        );
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    return {
      candidates: deduplicateCandidates(results),
      status: "partial",
      terminationReason: "page_limit_reached",
      pagesFetched,
      safetyLimitReached: true,
    };
  }

  async getByIdentifier(identifier: string): Promise<ServerCandidate> {
    const name = identifier.trim();
    if (!name)
      throw new RegistryError("Enter a Registry server identifier to inspect.");
    const url = new URL(
      `${REGISTRY_SERVERS_PATH}/${encodeURIComponent(name)}/versions/latest`,
      this.baseUrl,
    );
    const body = await this.requestJson(url);
    const candidate = normalizeRegistryRecord(body, this.baseUrl);
    if (!candidate) {
      throw new RegistryError(
        "The Registry did not return a valid server record for that identifier.",
      );
    }
    return candidate;
  }

  private async fetchPage(
    search: string,
    cursor?: string,
  ): Promise<RegistryPage> {
    const url = new URL(REGISTRY_SERVERS_PATH, this.baseUrl);
    url.searchParams.set("search", search);
    url.searchParams.set("version", "latest");
    url.searchParams.set("limit", String(PAGE_SIZE));
    if (cursor) url.searchParams.set("cursor", cursor);

    return parseRegistryPage(await this.requestJson(url));
  }

  private async requestJson(url: URL): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new RegistryError(
          `Registry request timed out after ${this.timeoutMs} ms.`,
          {
            cause: error,
          },
          "network_timeout",
        );
      }
      throw new RegistryError(
        "Could not reach the Official MCP Registry.",
        {
          cause: error,
        },
        "transport_failure",
      );
    }

    if (!response.ok) {
      const detail =
        response.status === 429
          ? "The registry is rate limiting requests. Wait a moment and try again."
          : `The registry returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`;
      throw new RegistryError(detail, undefined, "http_failure");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new RegistryError(
        "The registry returned invalid JSON.",
        {
          cause: error,
        },
        "invalid_response",
      );
    }

    return body;
  }
}

export function parseRegistryPage(body: unknown): RegistryPage {
  if (!isRecord(body) || !Array.isArray(body.servers)) {
    throw new RegistryError(
      "The registry response is missing its servers list.",
    );
  }

  if (body.metadata != null && !isRecord(body.metadata)) {
    throw new RegistryError(
      "The registry response contains invalid pagination metadata.",
    );
  }

  let nextCursor: string | undefined;
  if (isRecord(body.metadata) && body.metadata.nextCursor != null) {
    if (typeof body.metadata.nextCursor !== "string") {
      throw new RegistryError(
        "The registry response contains an invalid pagination cursor.",
      );
    }
    nextCursor = body.metadata.nextCursor || undefined;
  }
  return nextCursor
    ? { servers: body.servers, nextCursor }
    : { servers: body.servers };
}

export function normalizeRegistryRecord(
  record: unknown,
  baseUrl = REGISTRY_BASE_URL,
): ServerCandidate | undefined {
  if (!isRecord(record) || !isRecord(record.server)) return undefined;
  const server = record.server;
  if (typeof server.name !== "string" || !server.name.trim()) return undefined;
  const name = server.name.trim();
  const version = stringField(server.version);
  const packages = Array.isArray(server.packages) ? server.packages : [];
  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  const packageRecords = packages.filter(isRecord);
  const remoteRecords = remotes.filter(isRecord);
  const transports = [
    ...packageRecords.map((item) =>
      isRecord(item.transport) ? stringField(item.transport.type) : undefined,
    ),
    ...remoteRecords.map((item) => stringField(item.type)),
  ].filter((value): value is string => Boolean(value));
  const configurationInputs = [
    ...packageRecords.flatMap((item) =>
      parseInputRequirements(item.environmentVariables, "local-package"),
    ),
    ...remoteRecords.flatMap((item) =>
      parseNamedInputRequirements(item.variables, "remote-endpoint"),
    ),
  ];
  const remoteEndpoints = [
    ...packageRecords.map((item) =>
      isRecord(item.transport) ? stringField(item.transport.url) : undefined,
    ),
    ...remoteRecords.map((item) => stringField(item.url)),
  ]
    .filter((value): value is string => Boolean(value))
    .map(safeRegistryEndpoint)
    .filter((value): value is string => Boolean(value));
  const packageReferences = packageRecords.map((item) => {
    const registryType = stringField(item.registryType);
    const identifier = stringField(item.identifier);
    const packageVersion = stringField(item.version);
    const runtimeHint = stringField(item.runtimeHint);
    return {
      ...(registryType ? { registryType } : {}),
      ...(identifier ? { identifier } : {}),
      ...(packageVersion ? { version: packageVersion } : {}),
      ...(runtimeHint ? { runtimeHint } : {}),
    };
  });
  const deploymentModels: ServerCandidate["operational"]["deploymentModels"] =
    [];
  if (packageRecords.length > 0) deploymentModels.push("Local package");
  if (remoteRecords.length > 0) deploymentModels.push("Remote endpoint");

  const officialMetadata =
    isRecord(record._meta) &&
    isRecord(record._meta["io.modelcontextprotocol.registry/official"])
      ? record._meta["io.modelcontextprotocol.registry/official"]
      : undefined;
  const candidate: ServerCandidate = {
    name,
    registryIdentifier: name,
    operational: {
      deploymentModels,
      transports: [...new Set(transports)],
      packages: packageReferences,
      remoteEndpoints,
      configurationInputs,
      authentication: "Unknown",
      clientCompatibility: "Unknown",
      setupComplexity: "Unknown",
    },
    sourceRegistry: "Official MCP Registry",
    sourceRecordUrl: version
      ? `${baseUrl}${REGISTRY_SERVERS_PATH}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`
      : `${baseUrl}${REGISTRY_SERVERS_PATH}?search=${encodeURIComponent(name)}`,
  };

  const namespaceSeparator = name.lastIndexOf("/");
  if (namespaceSeparator > 0)
    candidate.registryNamespace = name.slice(0, namespaceSeparator);
  if (officialMetadata) {
    const registryStatus = stringField(officialMetadata.status);
    const publishedAt = stringField(officialMetadata.publishedAt);
    const updatedAt = stringField(officialMetadata.updatedAt);
    if (registryStatus) candidate.registryStatus = registryStatus;
    if (publishedAt) candidate.publishedAt = publishedAt;
    if (updatedAt) candidate.updatedAt = updatedAt;
    if (typeof officialMetadata.isLatest === "boolean")
      candidate.isLatest = officialMetadata.isLatest;
  }

  const title = stringField(server.title);
  const description = stringField(server.description);
  const repositoryUrl =
    isRecord(server.repository) && typeof server.repository.url === "string"
      ? safeHttpUrl(server.repository.url)
      : undefined;
  const websiteUrl = stringField(server.websiteUrl)
    ? safeHttpUrl(stringField(server.websiteUrl)!)
    : undefined;
  if (title) candidate.title = title;
  if (description) candidate.description = description;
  if (version) candidate.version = version;
  if (repositoryUrl) candidate.repositoryUrl = repositoryUrl;
  if (websiteUrl) candidate.websiteUrl = websiteUrl;
  return candidate;
}

function deduplicateCandidates(
  candidates: ServerCandidate[],
): ServerCandidate[] {
  const byId = new Map<string, ServerCandidate>();
  for (const candidate of candidates)
    byId.set(candidate.registryIdentifier, candidate);
  return [...byId.values()];
}

function safeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      hasSensitiveUrlQuery(url) ||
      hasCredentialLikeUrlFragment(url)
    )
      return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function safeRegistryEndpoint(value: string): string | undefined {
  try {
    return parsePublicHttpsEndpoint(value).toString();
  } catch {
    return undefined;
  }
}

function parseInputRequirements(
  value: unknown,
  deployment: "local-package" | "remote-endpoint",
): ServerCandidate["operational"]["configurationInputs"] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((item) => {
    const name = stringField(item.name);
    if (!name) return [];
    const description = stringField(item.description);
    return [
      {
        name,
        ...(typeof item.isRequired === "boolean"
          ? { required: item.isRequired }
          : {}),
        ...(typeof item.isSecret === "boolean"
          ? { secret: item.isSecret }
          : {}),
        ...(description ? { description } : {}),
        deployment,
      },
    ];
  });
}

function parseNamedInputRequirements(
  value: unknown,
  deployment: "local-package" | "remote-endpoint",
): ServerCandidate["operational"]["configurationInputs"] {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([name, input]) => {
    if (!isRecord(input)) return [];
    const description = stringField(input.description);
    return [
      {
        name,
        ...(typeof input.isRequired === "boolean"
          ? { required: input.isRequired }
          : {}),
        ...(typeof input.isSecret === "boolean"
          ? { secret: input.isSecret }
          : {}),
        ...(description ? { description } : {}),
        deployment,
      },
    ];
  });
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
