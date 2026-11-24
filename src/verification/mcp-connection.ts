import { Client, SSEClientTransport, SdkHttpError, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

export interface McpVerificationResult {
  status: "connection_verified" | "authentication_required" | "startup_failed" | "initialization_failed" | "endpoint_unreachable" | "timeout";
  detail: string;
  protocolVersion?: string;
  serverName?: string;
  startupVerified: boolean;
}
export interface VerificationOptions { timeoutMs?: number; versionNegotiation?: "auto" | "legacy"; fetchImpl?: typeof fetch; env?: Record<string, string> }

export async function verifyStdioMcp(
  command: string,
  args: string[],
  options: VerificationOptions = {},
): Promise<McpVerificationResult> {
  if (!await executableExists(command) || (args[0]?.endsWith("npx-cli.js") && !await executableExists(args[0]))) {
    return { status: "startup_failed", detail: "The configured runtime executable is unavailable.", startupVerified: false };
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const transport = new StdioClientTransport({
    command, args, stderr: "ignore", maxBufferSize: 1_000_000,
    ...(options.env ? { env: { ...getDefaultEnvironment(), ...options.env } } : {}),
  });
  let startupVerified = false;
  const startTransport = transport.start.bind(transport);
  transport.start = async () => { await startTransport(); startupVerified = true; };
  const client = makeClient(options);
  try {
    await connectWithTimeout(client, transport, timeoutMs);
    const version = client.getServerVersion();
    return {
      status: "connection_verified", detail: "The server completed MCP protocol negotiation and connection initialization.",
      startupVerified: true, ...(client.getNegotiatedProtocolVersion() ? { protocolVersion: client.getNegotiatedProtocolVersion()! } : {}),
      ...(version?.name ? { serverName: version.name } : {}),
    };
  } catch (error) {
    const started = startupVerified;
    if (isTimeout(error)) return { status: "timeout", detail: "MCP connection verification timed out; the child process was stopped.", startupVerified: started };
    if (isAuthenticationError(error)) return { status: "authentication_required", detail: "The server requires authentication before MCP connection initialization.", startupVerified: started };
    return {
      status: started ? "initialization_failed" : "startup_failed",
      detail: started ? "The process started but MCP protocol initialization failed." : "The configured executable could not be started.",
      startupVerified: started,
    };
  } finally {
    await closeStdioVerifier(client, transport);
  }
}

export async function verifyHttpMcp(endpoint: string, options: VerificationOptions = {}): Promise<McpVerificationResult> {
  let url: URL;
  try {
    url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password) return { status: "endpoint_unreachable", detail: "Only HTTPS endpoints without embedded credentials are supported.", startupVerified: false };
  } catch { return { status: "endpoint_unreachable", detail: "The remote MCP endpoint is not a valid URL.", startupVerified: false }; }
  const timeoutMs = options.timeoutMs ?? 12_000;
  const clients = [
    { client: makeClient(options), transport: new StreamableHTTPClientTransport(url, { redirectPolicy: "same-origin", requestInit: { redirect: "manual" }, ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}) }) },
    { client: makeClient(options), transport: new SSEClientTransport(url, { requestInit: { redirect: "manual" }, ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}) }) },
  ];
  let lastError: unknown;
  for (const { client, transport } of clients) {
    try {
      await connectWithTimeout(client, transport, timeoutMs);
      const version = client.getServerVersion();
      return {
        status: "connection_verified", detail: "The remote endpoint completed MCP protocol negotiation and connection initialization.", startupVerified: false,
        ...(client.getNegotiatedProtocolVersion() ? { protocolVersion: client.getNegotiatedProtocolVersion()! } : {}),
        ...(version?.name ? { serverName: version.name } : {}),
      };
    } catch (error) {
      lastError = error;
      if (isTimeout(error)) return { status: "timeout", detail: "Remote MCP connection verification timed out.", startupVerified: false };
      if (isAuthenticationError(error)) return { status: "authentication_required", detail: "The remote MCP endpoint requires authentication.", startupVerified: false };
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  }
  return {
    status: isNetworkError(lastError) ? "endpoint_unreachable" : "initialization_failed",
    detail: isNetworkError(lastError) ? "The remote MCP endpoint could not be reached." : "The endpoint did not complete MCP protocol initialization over Streamable HTTP or SSE.",
    startupVerified: false,
  };
}

async function connectWithTimeout(client: Client, transport: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "MCPGET_TIMEOUT" })), timeoutMs);
  });
  try { await Promise.race([client.connect(transport), timeout]); }
  finally { if (timer) clearTimeout(timer); }
}
async function closeStdioVerifier(client: Client, transport: StdioClientTransport): Promise<void> {
  const started = transport.pid !== null;
  const previousOnClose = transport.onclose;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  transport.onclose = () => {
    try { previousOnClose?.(); }
    finally { resolveClosed(); }
  };
  let cleanupError: unknown;
  try { await client.close(); } catch (error) { cleanupError = error; }
  try { await transport.close(); } catch (error) { cleanupError ??= error; }
  if (started && transport.pid !== null) await waitForTransportClose(closed, 1_000);
  if (started && transport.pid !== null) throw new Error("The verification server process did not close after bounded cleanup.");
  if (cleanupError) throw new Error("MCP verification cleanup failed.", { cause: cleanupError });
}

async function waitForTransportClose(closed: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function executableExists(command: string): Promise<boolean> {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const candidates = isAbsolute(command)
    ? [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)]
    : (process.env.PATH ?? "").split(delimiter).flatMap((directory) => extensions.map((extension) => join(directory, `${command}${extension.toLowerCase()}`)));
  for (const candidate of candidates) { try { await access(candidate); return true; } catch { /* search remaining PATH entries */ } }
  return false;
}
function makeClient(options: VerificationOptions): Client {
  return new Client(
    { name: "mcpget-verifier", version: "0.1.0" },
    { versionNegotiation: { mode: options.versionNegotiation ?? "auto", probe: { timeoutMs: Math.min(3_000, options.timeoutMs ?? 15_000) } } },
  );
}
function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "MCPGET_TIMEOUT";
}
function isAuthenticationError(error: unknown): boolean {
  return error instanceof UnauthorizedError || (error instanceof SdkHttpError && (error.status === 401 || error.status === 403)) ||
    (error instanceof Error && (/unauthorized|authentication|required.*credential/i.test(error.name) || /\b401\b|\b403\b/.test(error.message)));
}
function isNetworkError(error: unknown): boolean {
  return error instanceof SdkHttpError || (typeof error === "object" && error !== null && typeof (error as { status?: unknown }).status === "number") ||
    (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "number" && (error as { code: number }).code >= 300) ||
    error instanceof TypeError || (error instanceof Error && /fetch|network|connect|dns|timeout/i.test(error.message));
}
