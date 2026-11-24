import { describe, expect, it } from "vitest";
import type { ServerCandidate } from "../../src/models/server-candidate.js";
import { evaluateCandidate, evaluateCandidates } from "../../src/discovery/evaluate-candidates.js";
import { resolveServiceIdentity } from "../../src/discovery/url-resolver.js";

const notion = resolveServiceIdentity("notion.com");
const linear = resolveServiceIdentity("https://linear.app");

function candidate(
  name: string,
  fields: Partial<ServerCandidate> = {},
): ServerCandidate {
  return {
    name,
    registryIdentifier: name,
    operational: {
      deploymentModels: [],
      transports: [],
      packages: [],
      remoteEndpoints: [],
      configurationInputs: [],
      authentication: "Unknown",
      clientCompatibility: "Unknown",
      setupComplexity: "Unknown",
    },
    sourceRegistry: "Official MCP Registry",
    sourceRecordUrl: "https://registry.modelcontextprotocol.io/v0.1/servers",
    ...fields,
  };
}

describe("candidate evaluation", () => {
  it("classifies broad Notion content operations as a direct integration", () => {
    const result = evaluateCandidate(
      notion,
      candidate("io.github.writer/notion", {
        title: "Notion MCP",
        description: "Search, read, create, and update Notion pages and databases.",
        repositoryUrl: "https://github.com/writer/notion-mcp",
      }),
    );
    expect(result.relevance).toBe("Direct integration");
    expect(result.confidence).toBe("Medium");
    expect(result.capabilities.map((item) => item.name)).toContain("Database queries");
    expect(result.trust).toBe("Unverified");
    expect(result.evidence.some((item) => item.dimension === "relevance")).toBe(true);
  });

  it("keeps relevance and confidence consistent across product aliases and known domains", () => {
    const record = candidate("com.vendor/notion", {
      title: "Notion MCP",
      description: "Search and update Notion pages.",
      operational: {
        deploymentModels: ["Remote endpoint"],
        transports: ["streamable-http"],
        packages: [],
        remoteEndpoints: ["https://mcp.notion.com/mcp"],
        configurationInputs: [],
        authentication: "Unknown",
        clientCompatibility: "Unknown",
        setupComplexity: "Unknown",
      },
    });
    const fromAlias = evaluateCandidate(resolveServiceIdentity("notion"), record);
    const fromCom = evaluateCandidate(resolveServiceIdentity("https://notion.com"), record);
    const fromSo = evaluateCandidate(resolveServiceIdentity("https://www.notion.so/workspace"), record);
    expect([fromAlias.relevance, fromCom.relevance, fromSo.relevance]).toEqual([
      "Direct integration",
      "Direct integration",
      "Direct integration",
    ]);
    expect([fromAlias.confidence, fromCom.confidence, fromSo.confidence]).toEqual([
      "High",
      "High",
      "High",
    ]);
  });

  it("classifies Notion URL Shape as specialized rather than general-purpose", () => {
    const result = evaluateCandidate(
      notion,
      candidate("io.github.sadri-dridi/notion-url-shape", {
        title: "Notion URL Shape",
        description: "Check a Notion URL shape. Path discarded.",
      }),
    );
    expect(result.relevance).toBe("Specialized integration");
    expect(result.recommendationEligible).toBe(false);
  });

  it("classifies narrow Notion file upload and project bootstrap tools as specialized", () => {
    const upload = evaluateCandidate(
      notion,
      candidate("author/notion-large-file-upload", {
        title: "Notion Large File Upload",
        description: "Upload large files to Notion and attach them to pages.",
      }),
    );
    expect(upload.relevance).toBe("Specialized integration");
  });

  it("rejects Linear Programming and namespace-only Notion keyword matches", () => {
    const math = evaluateCandidate(
      linear,
      candidate("io.github.author/linear-programming-mcp", {
        title: "Linear Programming MCP",
        description: "Read, check, lint, scaffold and run linear programming code.",
      }),
    );
    const namespaceOnly = evaluateCandidate(
      notion,
      candidate("io.github.quietnotion/barevalue", {
        title: "Barevalue",
        description: "AI podcast editing and audio mastering.",
      }),
    );
    expect(math.relevance).toBe("Unrelated / false positive");
    expect(math.confidence).toBe("Low");
    expect(namespaceOnly.relevance).toBe("Unrelated / false positive");
    expect(namespaceOnly.confidence).toBe("Low");
  });

  it("does not elevate a matching domain when metadata contradicts the service", () => {
    const result = evaluateCandidate(
      linear,
      candidate("someone/notion-math", {
        title: "Linear Programming",
        description: "Mathematical linear algebra and equation solver for linear.app data.",
        websiteUrl: "https://linear.app/tools/math",
      }),
    );
    expect(result.relevance).toBe("Unrelated / false positive");
    expect(result.confidence).toBe("Low");
  });

  it("does not count a target-domain string found only in another URL's query", () => {
    const result = evaluateCandidate(
      linear,
      candidate("someone/unrelated", {
        title: "Other MCP",
        description: "A separate integration.",
        websiteUrl: "https://evil.example/redirect?next=linear.app",
      }),
    );
    expect(result.relevance).toBe("Unrelated / false positive");
    expect(result.evidence.some((item) => item.type === "product-domain-reference")).toBe(false);
  });

  it("uses unknown trust states instead of inferring a community or vendor publisher", () => {
    const noPublisher = evaluateCandidate(
      notion,
      candidate("com.notion/mcp", {
        description: "Official Notion MCP server.",
        websiteUrl: "https://mcp.notion.com/mcp",
      }),
    );
    const withRepo = evaluateCandidate(
      notion,
      candidate("io.github.author/notion", {
        description: "A Notion connector.",
        repositoryUrl: "https://github.com/author/notion",
      }),
    );
    expect(noPublisher.trust).toBe("Insufficient evidence");
    expect(withRepo.trust).toBe("Unverified");
    expect(withRepo.trust).not.toBe("Community maintained");
    expect(noPublisher.evidence.some((item) => item.type === "publisher-officialness-claim")).toBe(true);
  });

  it("recommends the broadest direct candidate without letting trust decide", () => {
    const report = evaluateCandidates(notion, [
      candidate("a/weak", {
        title: "Notion upload",
        description: "Upload files to Notion pages.",
        repositoryUrl: "https://github.com/a/weak",
      }),
      candidate("z/broad", {
        title: "Notion workspace integration",
        description: "Search, read, create and update Notion pages, databases and workspaces.",
        repositoryUrl: "https://github.com/z/broad",
      }),
    ]);
    expect(report.recommendedCandidateId).toBe("z/broad");
    expect(report.evaluations.find((item) => item.candidate.name === "a/weak")?.relevance).toBe(
      "Specialized integration",
    );
  });

  it("returns no forced recommendation when there are no broad candidates", () => {
    const report = evaluateCandidates(notion, [
      candidate("io.github.sadri-dridi/notion-url-shape", {
        title: "Notion URL Shape",
        description: "Check a Notion URL shape.",
      }),
    ]);
    expect(report.recommendedCandidateId).toBeUndefined();
    expect(report.recommendationMessage).toContain("No confident recommendation");
  });

  it("does not declare a winner when equally supported candidates tie", () => {
    const fields = {
      title: "Notion workspace integration",
      description: "Search, read and update Notion pages and databases.",
      repositoryUrl: "https://github.com/org/project",
      version: "1.0.0",
      registryStatus: "active",
    };
    const report = evaluateCandidates(notion, [
      candidate("a/notion", fields),
      candidate("b/notion", { ...fields, repositoryUrl: "https://github.com/other/project" }),
    ]);
    expect(report.recommendationStatus).toBe("similar candidates");
    expect(report.recommendedCandidateId).toBeUndefined();
    expect(report.alternativeCandidateIds).toHaveLength(2);
  });

  it("compares deployment choices with evidence and surfaces a materially different hosted option", () => {
    const operations = "Search, read, create and update Notion pages, databases and workspaces.";
    const local = candidate("community/notion-local", {
      title: "Notion Workspace Tools",
      description: operations,
      repositoryUrl: "https://github.com/community/notion-local",
      version: "1.2.0",
      registryStatus: "active",
      operational: {
        deploymentModels: ["Local package"], transports: ["stdio"],
        packages: [{ registryType: "npm", identifier: "notion-local", version: "1.2.0", runtimeHint: "npx" }],
        remoteEndpoints: [], configurationInputs: [], authentication: "Unknown", clientCompatibility: "Unknown", setupComplexity: "Unknown",
      },
    });
    const hosted = candidate("service/mcp", {
      title: "Notion MCP",
      description: "Official Notion integration for workspace pages.",
      version: "1.0.0",
      registryStatus: "active",
      operational: {
        deploymentModels: ["Remote endpoint"], transports: ["streamable-http"], packages: [],
        remoteEndpoints: ["https://mcp.notion.com/mcp"], configurationInputs: [],
        authentication: "Unknown", clientCompatibility: "Unknown", setupComplexity: "Unknown",
      },
    });
    const report = evaluateCandidates(notion, [local, hosted]);
    expect(report.recommendedCandidateId).toBe(local.registryIdentifier);
    expect(report.alternativeCandidateIds).toContain(hosted.registryIdentifier);
    expect(report.evaluations.find((item) => item.candidate.registryIdentifier === hosted.registryIdentifier)?.hostingAssessment)
      .toContain("known service domain");
    expect(report.evaluations.find((item) => item.candidate.registryIdentifier === hosted.registryIdentifier)?.trust)
      .not.toBe("Vendor verified");
  });

  it("allows a well-supported local package to outrank a less documented third-party endpoint", () => {
    const description = "Search, read, create and update Notion pages, databases and workspaces.";
    const makeOperational = (remote: boolean) => ({
      deploymentModels: [remote ? "Remote endpoint" as const : "Local package" as const],
      transports: [remote ? "streamable-http" : "stdio"],
      packages: remote ? [] : [{ registryType: "npm", identifier: "notion-tool", version: "1.0.0", runtimeHint: "npx" }],
      remoteEndpoints: remote ? ["https://host.example/mcp"] : [],
      configurationInputs: [], authentication: "Unknown" as const,
      clientCompatibility: "Unknown" as const, setupComplexity: "Unknown" as const,
    });
    const report = evaluateCandidates(notion, [
      candidate("a/remote-notion", { title: "Notion workspace", description, operational: makeOperational(true) }),
      candidate("z/local-notion", { title: "Notion workspace", description, repositoryUrl: "https://github.com/z/local", version: "1.0.0", registryStatus: "active", operational: makeOperational(false) }),
    ]);
    expect(report.recommendedCandidateId).toBe("z/local-notion");
  });

  it("sorts tied evaluations deterministically by Registry identifier", () => {
    const report = evaluateCandidates(notion, [
      candidate("z/notion", { title: "Notion MCP", description: "Notion connector." }),
      candidate("a/notion", { title: "Notion MCP", description: "Notion connector." }),
    ]);
    expect(report.evaluations.map((item) => item.candidate.registryIdentifier)).toEqual([
      "a/notion",
      "z/notion",
    ]);
  });

  it("groups likely duplicate project entries but does not merge shared organization or similar names", () => {
    const repository = "https://github.com/acme/notion-mcp.git";
    const pack = (version: string) => ({
      deploymentModels: ["Local package" as const], transports: ["stdio"],
      packages: [{ registryType: "npm", identifier: "@acme/notion-mcp", version }],
      remoteEndpoints: [], configurationInputs: [], authentication: "Unknown" as const,
      clientCompatibility: "Unknown" as const, setupComplexity: "Unknown" as const,
    });
    const report = evaluateCandidates(notion, [
      candidate("registry-a/notion-mcp", { title: "Notion MCP", description: "Search, read and update Notion pages and databases.", repositoryUrl: "https://github.com/acme/notion-mcp", version: "2.45.1", operational: pack("2.45.1") }),
      candidate("registry-b/notion-mcp", { title: "Notion MCP", description: "Search, read and update Notion pages and databases.", repositoryUrl: repository, version: "2.42.0", operational: pack("2.42.0") }),
      candidate("registry-c/notion-mcp", { title: "Notion MCP", description: "Search and read Notion pages.", repositoryUrl: "https://github.com/acme/another-project", operational: { ...pack("2.45.1"), packages: [{ registryType: "npm", identifier: "@acme/other-notion-mcp", version: "2.45.1" }] } }),
    ]);
    const grouped = report.evaluations.find((item) => item.candidate.registryIdentifier === "registry-a/notion-mcp");
    expect(grouped?.duplicate?.confidence).toBe("Likely same project");
    expect(grouped?.duplicate?.relatedIdentifiers).toContain("registry-b/notion-mcp");
    expect(grouped?.duplicate?.versionNote).toContain("2.45.1 appears newer than 2.42.0");
    expect(report.evaluations.find((item) => item.candidate.registryIdentifier === "registry-c/notion-mcp")?.duplicate).toBeUndefined();
  });

  it("surfaces browser-session and filesystem requirements as elevated concerns without exposing values", () => {
    const result = evaluateCandidate(notion, candidate("author/notion", {
      title: "Notion workspace integration",
      description: "Search, read and update Notion pages and databases.",
      operational: {
        deploymentModels: ["Local package"], transports: ["stdio"], packages: [], remoteEndpoints: [],
        configurationInputs: [
          { name: "NOTION_TOKEN", secret: true, description: "Browser token_v2 session cookie", deployment: "local-package" },
          { name: "NOTION_ALLOWED_DIR", description: "Local filesystem folder path", deployment: "local-package" },
        ],
        authentication: "Unknown", clientCompatibility: "Unknown", setupComplexity: "Unknown",
      },
    }));
    expect(result.securityRisk).toBe("Elevated concern");
    expect(result.securityFindings.join(" ")).toContain("browser-session credential");
    expect(result.securityFindings.join(" ")).toContain("local resource access");
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("does not inflate functional coverage from repeated verbose descriptions", () => {
    const short = "Search and read Notion pages and databases.";
    const verbose = `${short} ${"Search, read, pages, databases. ".repeat(30)}`;
    const a = evaluateCandidate(notion, candidate("author/notion-a", { title: "Notion", description: short }));
    const b = evaluateCandidate(notion, candidate("author/notion-b", { title: "Notion", description: verbose }));
    expect(b.capabilities.map((item) => item.name)).toEqual(a.capabilities.map((item) => item.name));
    expect(b.capabilities.length).toBe(a.capabilities.length);
    expect(b.evidenceQuality).toBe(a.evidenceQuality);
  });
});
