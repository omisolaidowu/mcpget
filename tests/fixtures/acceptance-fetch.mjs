/* global process, URL, Response */
const mode = process.env.MCPGET_ACCEPTANCE_MODE ?? "primary";

function record(name, variables) {
  return {
    server: {
      name,
      title: name.includes("/second")
        ? "Notion Acceptance Second MCP"
        : "Notion Acceptance Test MCP",
      description: "Controlled Notion acceptance test MCP server.",
      version: "1.0.0",
      remotes: [
        {
          type: "streamable-http",
          url: "https://93.184.216.34/mcp",
          ...(variables ? { variables } : {}),
        },
      ],
    },
  };
}

const primary = record("com.notion/acceptance-test");
const second = record("com.notion/second");
const missingCredential = record("com.notion/acceptance-test", {
  ACCEPTANCE_TOKEN: {
    isRequired: true,
    isSecret: true,
    description: "Acceptance test credential",
  },
});

globalThis.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL(input.url);

  if (url.hostname === "registry.modelcontextprotocol.io") {
    if (url.pathname.includes("/versions/latest")) {
      if (mode === "invalid-candidate") {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      }
      const identifier = decodeURIComponent(
        url.pathname.split("/v0.1/servers/")[1].split("/versions/latest")[0],
      );
      if (identifier === "com.notion/second") return Response.json(second);
      if (mode === "missing-credential")
        return Response.json(missingCredential);
      return Response.json(primary);
    }

    const candidates = mode === "ambiguous" ? [primary, second] : [primary];
    return Response.json({ servers: candidates, metadata: {} });
  }

  if (url.hostname === "93.184.216.34") {
    if (mode === "failure") {
      return new Response("unavailable", { status: 503 });
    }
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (body?.method === "server/discover") {
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: "Method not found" },
      });
    }
    if (body?.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: {
            name: "acceptance-test",
            version: "1.0.0",
          },
        },
      });
    }
    return new Response(null, { status: 202 });
  }

  throw new Error(`Acceptance fetch fixture received unexpected URL: ${url}`);
};
