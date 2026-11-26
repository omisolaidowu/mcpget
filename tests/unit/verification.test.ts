import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  verifyHttpMcp,
  verifyStdioMcp,
} from "../../src/verification/mcp-connection.js";

const node = process.execPath;
const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

describe("stdio MCP verification", () => {
  it("completes an MCP initialize exchange and closes the child", async () => {
    const script = `let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const q=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(q.method==='server/discover')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'not supported'}})+'\\n');else if(q.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'test-server',version:'1'}}})+'\\n');}});`;
    const result = await verifyStdioMcp(node, ["-e", script], {
      timeoutMs: 2000,
    });
    expect(result).toMatchObject({
      status: "connection_verified",
      protocolVersion: "2025-11-25",
      serverName: "test-server",
      startupVerified: true,
    });
  });

  it("reaps the verification child after successful initialization", async () => {
    const result = await verifyWithChildPid(`
      const fs=require('node:fs');
      fs.writeFileSync(process.env.MCPGET_PID_FILE,String(process.pid));
      process.stdin.on('end',()=>process.exit(0));
      let b='';
      process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){
        const q=JSON.parse(b.slice(0,i));b=b.slice(i+1);
        if(q.method==='server/discover')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'not supported'}})+'\\n');
        else if(q.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{protocolVersion:'2025-11-25',capabilities:{},serverInfo:{name:'exit-test',version:'1'}}})+'\\n');
      }});
    `);
    expect(result.status).toBe("connection_verified");
  });

  it("reaps the verification child after failed initialization", async () => {
    const result = await verifyWithChildPid(
      `
      const fs=require('node:fs');
      fs.writeFileSync(process.env.MCPGET_PID_FILE,String(process.pid));
      process.stdin.on('end',()=>process.exit(0));
      let b='';
      process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){
        const q=JSON.parse(b.slice(0,i));b=b.slice(i+1);
        if(q.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32602,message:'bad'}})+'\\n');
      }});
    `,
      { versionNegotiation: "legacy" },
    );
    expect(result.status).toBe("initialization_failed");
  });

  it("force-terminates a verification child that ignores graceful shutdown", async () => {
    const started = Date.now();
    const result = await verifyWithChildPid(
      `
      const fs=require('node:fs');
      fs.writeFileSync(process.env.MCPGET_PID_FILE,String(process.pid));
      process.stdin.on('end',()=>{});
      process.on('SIGTERM',()=>{});
      setInterval(()=>{},1000);
    `,
      { timeoutMs: 50, versionNegotiation: "legacy" },
    );
    expect(result.status).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(7000);
  });

  it("uses supplied environment values for startup verification without exposing them", async () => {
    const secret = "provided-test-value";
    const script = `if(!process.env.MCPGET_TEST_CREDENTIAL)process.exit(2);let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const q=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(q.method==='server/discover')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'not supported'}})+'\\n');else if(q.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{protocolVersion:'2025-11-25',capabilities:{},serverInfo:{name:'credential-test',version:'1'}}})+'\\n');}});`;
    const result = await verifyStdioMcp(node, ["-e", script], {
      timeoutMs: 2000,
      env: { MCPGET_TEST_CREDENTIAL: secret },
    });
    expect(result).toMatchObject({
      status: "connection_verified",
      serverName: "credential-test",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("distinguishes startup exit from protocol failure", async () => {
    const missing = await verifyStdioMcp(
      "mcpget-command-that-does-not-exist",
      [],
      { timeoutMs: 1000 },
    );
    expect(missing.status).toBe("startup_failed");
    const script = `let b='';process.stdin.on('data',chunk=>{b+=chunk;for(let i;(i=b.indexOf('\\n'))>=0;){const q=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(q.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32602,message:'bad'}})+'\\n');}});`;
    await expect(
      verifyStdioMcp(node, ["-e", script], {
        timeoutMs: 1000,
        versionNegotiation: "legacy",
      }),
    ).resolves.toMatchObject({
      status: "initialization_failed",
      startupVerified: true,
    });
  });

  it("times out and cleans up a server that never answers", async () => {
    const result = await verifyStdioMcp(
      node,
      ["-e", "setInterval(()=>{},1000)"],
      { timeoutMs: 50, versionNegotiation: "legacy" },
    );
    expect(result.status).toBe("timeout");
  });
});

async function verifyWithChildPid(
  script: string,
  options: { timeoutMs?: number; versionNegotiation?: "auto" | "legacy" } = {},
): Promise<{ status: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "mcpget-verify-pid-"));
  const pidFile = path.join(directory, "child.pid");
  let pid: number | undefined;
  try {
    const result = await verifyStdioMcp(node, ["-e", script], {
      ...options,
      env: { MCPGET_PID_FILE: pidFile },
    });
    pid = Number(await readFile(pidFile, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);
    const exited = await waitForExit(pid);
    expect(exited).toBe(true);
    return result;
  } finally {
    if (!pid) {
      try {
        pid = Number(await readFile(pidFile, "utf8"));
      } catch {
        /* Child may not have started. */
      }
    }
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* The verifier already reaped the process. */
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitForExit(pid: number, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

describe("remote MCP verification", () => {
  it("distinguishes authentication requirements from endpoint reachability", async () => {
    const authFetch = (async () =>
      new Response("", { status: 401 })) as typeof fetch;
    await expect(
      verifyHttpMcp("https://mcp.example.com", {
        timeoutMs: 1000,
        fetchImpl: authFetch,
        resolveHost: publicResolver,
        versionNegotiation: "legacy",
      }),
    ).resolves.toMatchObject({ status: "authentication_required" });
    const failFetch = (async () =>
      new Response("", { status: 503 })) as typeof fetch;
    await expect(
      verifyHttpMcp("https://mcp.example.com", {
        timeoutMs: 1000,
        fetchImpl: failFetch,
        resolveHost: publicResolver,
        versionNegotiation: "legacy",
      }),
    ).resolves.toMatchObject({ status: "endpoint_unreachable" });
  });

  it("preserves Streamable HTTP 401 evidence when SSE fallback fails generically", async () => {
    const methods: string[] = [];
    const fetchImpl = statusFetch({ POST: 401, GET: 503 }, methods);
    const result = await verifyHttpMcp("https://mcp.example.com", {
      fetchImpl,
      resolveHost: publicResolver,
      versionNegotiation: "legacy",
    });
    expect(methods).toContain("POST");
    expect(methods).toContain("GET");
    expect(result).toMatchObject({
      status: "authentication_required",
      detail: expect.stringContaining("HTTP 401"),
    });
  });

  it("preserves Streamable HTTP 403 access-denied evidence over a generic fallback", async () => {
    const result = await verifyHttpMcp("https://mcp.example.com", {
      fetchImpl: statusFetch({ POST: 403, GET: 503 }),
      resolveHost: publicResolver,
      versionNegotiation: "legacy",
    });
    expect(result).toMatchObject({
      status: "authentication_required",
      detail: expect.stringContaining("denied access (HTTP 403)"),
    });
  });

  it("preserves SSE authentication evidence when Streamable HTTP fails generically", async () => {
    const result = await verifyHttpMcp("https://mcp.example.com", {
      fetchImpl: statusFetch({ POST: 503, GET: 401 }),
      resolveHost: publicResolver,
      versionNegotiation: "legacy",
    });
    expect(result).toMatchObject({
      status: "authentication_required",
      detail: expect.stringContaining("HTTP 401"),
    });
  });

  it("reports generic failures from both transports as unreachable", async () => {
    const result = await verifyHttpMcp("https://mcp.example.com", {
      fetchImpl: statusFetch({ POST: 503, GET: 503 }),
      resolveHost: publicResolver,
      versionNegotiation: "legacy",
    });
    expect(result.status).toBe("endpoint_unreachable");
  });

  it("preserves protocol initialization failure over a generic fallback error", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (String(init?.method).toUpperCase() === "GET")
        return new Response("", { status: 503 });
      const request = JSON.parse(String(init?.body)) as {
        id: number | string;
      };
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32602, message: "Invalid initialization request" },
      });
    };
    const result = await verifyHttpMcp("https://mcp.example.com", {
      fetchImpl,
      resolveHost: publicResolver,
      versionNegotiation: "legacy",
    });
    expect(result.status).toBe("initialization_failed");
  });

  it("does not expose authentication headers, tokens, or log contents", async () => {
    const secret = "never-print-this-token";
    const authorizationHeaders: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization) authorizationHeaders.push(authorization);
      return new Response("", {
        status: 401,
        headers: {
          "www-authenticate": `Bearer error_description="${secret}"`,
        },
      });
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const result = await verifyHttpMcp("https://mcp.example.com", {
        fetchImpl,
        resolveHost: publicResolver,
        versionNegotiation: "legacy",
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(authorizationHeaders).toEqual([]);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("requires a valid initialize result and sends initialized notification", async () => {
    const requests: string[] = [];
    const mockedFetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = String(init?.body ?? "");
      requests.push(body);
      if (body.includes('"method":"initialize"')) {
        const request = JSON.parse(body) as { id: number | string };
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "remote-test", version: "1" },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    await expect(
      verifyHttpMcp("https://mcp.example.com", {
        timeoutMs: 1000,
        fetchImpl: mockedFetch,
        resolveHost: publicResolver,
        versionNegotiation: "legacy",
      }),
    ).resolves.toMatchObject({
      status: "connection_verified",
      serverName: "remote-test",
    });

    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[1]).toContain("notifications/initialized");
  });

  it("follows only same-origin HTTPS redirects through the secure fetch", async () => {
    const requested: string[] = [];
    const redirectFetch: typeof fetch = async (input) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      requested.push(requestUrl);
      if (new URL(requestUrl).pathname === "/mcp") {
        return new Response(null, {
          status: 307,
          headers: { location: "/redirected" },
        });
      }
      return new Response("", { status: 401 });
    };
    const result = await verifyHttpMcp("https://mcp.example.com/mcp", {
      timeoutMs: 1000,
      fetchImpl: redirectFetch,
      resolveHost: publicResolver,
      versionNegotiation: "legacy",
    });
    expect(result.status).toBe("authentication_required");
    expect(requested).toContain("https://mcp.example.com/redirected");
  });

  it.each([
    ["loopback redirect", "https://127.0.0.1/private"],
    ["private redirect", "https://192.168.1.10/private"],
    ["HTTPS downgrade", "http://mcp.example.com/private"],
  ])("does not follow %s", async (_label, target) => {
    const requested: string[] = [];
    const redirectFetch: typeof fetch = async (input) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      requested.push(requestUrl);
      return new Response(null, {
        status: 307,
        headers: { location: target },
      });
    };
    await verifyHttpMcp("https://mcp.example.com/mcp", {
      timeoutMs: 1000,
      fetchImpl: redirectFetch,
      resolveHost: publicResolver,
      versionNegotiation: "legacy",
    });
    expect(requested.length).toBeGreaterThan(0);
    expect(
      requested.every((url) => new URL(url).hostname === "mcp.example.com"),
    ).toBe(true);
    expect(requested.some((url) => url === target)).toBe(false);
  });

  it("bounds same-origin redirect loops and does not send authorization headers cross-origin", async () => {
    const requested: string[] = [];
    const authorizationHeaders: string[] = [];
    const redirectFetch: typeof fetch = async (input, init) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      requested.push(requestUrl);
      const headers = new Headers(init?.headers);
      const authorization = headers.get("authorization");
      if (authorization) authorizationHeaders.push(authorization);
      return new Response(null, {
        status: 307,
        headers: { location: "https://other.example.com/redirect" },
      });
    };
    await verifyHttpMcp("https://mcp.example.com/mcp", {
      timeoutMs: 1000,
      fetchImpl: redirectFetch,
      resolveHost: publicResolver,
      versionNegotiation: "legacy",
    });
    expect(
      requested.every((url) => new URL(url).hostname === "mcp.example.com"),
    ).toBe(true);
    expect(authorizationHeaders).toEqual([]);
  });

  it("bounds a redirect loop at the SDK transport limit", async () => {
    const requested: string[] = [];
    const loopFetch: typeof fetch = async (input) => {
      requested.push(input instanceof Request ? input.url : String(input));
      return new Response(null, {
        status: 307,
        headers: { location: "https://mcp.example.com/mcp" },
      });
    };
    await verifyHttpMcp("https://mcp.example.com/mcp", {
      timeoutMs: 1000,
      fetchImpl: loopFetch,
      resolveHost: publicResolver,
      versionNegotiation: "legacy",
    });
    expect(requested.length).toBeGreaterThan(1);
    expect(requested.length).toBeLessThan(20);
  });
});

function statusFetch(
  statusByMethod: Record<string, number>,
  methods: string[] = [],
): typeof fetch {
  return async (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    methods.push(method);
    return new Response("", { status: statusByMethod[method] ?? 503 });
  };
}
