import { describe, expect, it } from "vitest";
import { toSearchJson, successResponse } from "../../src/cli/output.js";
import { evaluateCandidates } from "../../src/discovery/evaluate-candidates.js";
import { resolveServiceIdentity } from "../../src/discovery/url-resolver.js";
import type {
  CandidateEvaluation,
  RecommendationReport,
} from "../../src/models/candidate-evaluation.js";
import type { ServerCandidate } from "../../src/models/server-candidate.js";

function makeCandidate(index: number): ServerCandidate {
  const description =
    "Search, read, create, update, and delete Notion pages and databases. " +
    "Includes workspace browsing, file handling, and structured queries. ".repeat(
      4,
    );
  return {
    name: `io.github.example/notion-server-${index}`,
    title: `Notion workspace server ${index}`,
    description,
    registryIdentifier: `io.github.example/notion-server-${index}`,
    registryNamespace: "io.github.example",
    version: "1.2.3",
    registryStatus: "active",
    publishedAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-02-01T00:00:00Z",
    isLatest: true,
    repositoryUrl: "https://github.com/example/notion-server",
    websiteUrl: "https://example.com/notion",
    operational: {
      deploymentModels: ["Local package"],
      transports: ["stdio"],
      packages: [
        {
          registryType: "npm",
          identifier: "@example/notion-mcp",
          version: "1.2.3",
          runtimeHint: "node",
        },
      ],
      remoteEndpoints: [],
      configurationInputs: [
        {
          name: "NOTION_TOKEN",
          required: true,
          secret: true,
          description: "Notion integration token for the selected workspace.",
          deployment: "local-package",
        },
      ],
      authentication: "Unknown",
      clientCompatibility: "Unknown",
      setupComplexity: "Unknown",
    },
    sourceRegistry: "Official MCP Registry",
    sourceRecordUrl:
      "https://registry.modelcontextprotocol.io/v0.1/servers/notion-server",
  };
}

function legacyCandidate(
  evaluation: CandidateEvaluation,
  topCandidateId?: string,
): Record<string, unknown> {
  const candidate = evaluation.candidate;
  return {
    registryIdentifier: candidate.registryIdentifier,
    name: candidate.name,
    ...(candidate.title ? { title: candidate.title } : {}),
    ...(candidate.description ? { description: candidate.description } : {}),
    ...(candidate.version ? { version: candidate.version } : {}),
    source: candidate.sourceRegistry,
    sourceRecordUrl: candidate.sourceRecordUrl,
    relevance: evaluation.relevance,
    confidence: evaluation.confidence,
    trust: evaluation.trust,
    suitability: evaluation.suitability,
    suitabilityReasons: evaluation.suitabilityReasons,
    evidenceQuality: evaluation.evidenceQuality,
    operationalFriction: evaluation.operationalFriction,
    hostingAssessment: evaluation.hostingAssessment,
    securityRisk: evaluation.securityRisk,
    securityFindings: evaluation.securityFindings,
    maintenanceSignals: evaluation.maintenanceSignals,
    ...(evaluation.duplicate ? { duplicate: evaluation.duplicate } : {}),
    capabilities: evaluation.capabilities,
    evidence: evaluation.evidence,
    operational: candidate.operational,
    recommended: candidate.registryIdentifier === topCandidateId,
  };
}

function legacyStatus(report: RecommendationReport): string {
  switch (report.recommendationStatus) {
    case "recommended":
      return "confident";
    case "candidate":
      return "qualified";
    case "similar_candidates":
      return "similar candidates";
    case "no_recommendation":
      return "none";
  }
}

describe("search JSON payload size", () => {
  it("reduces a complete representative five-candidate payload by at least 30%", () => {
    const report = evaluateCandidates(
      resolveServiceIdentity("notion.com"),
      Array.from({ length: 5 }, (_, index) => makeCandidate(index + 1)),
    );
    const discovery = {
      status: "complete",
      terminationReason: "cursor_exhausted",
      pagesFetched: 3,
      safetyLimitReached: false,
    };
    const legacy = successResponse("search", {
      schemaVersion: 2,
      service: {
        name: report.service.canonicalName,
        domain: report.service.domain,
        aliases: report.service.productAliases,
        domains: report.service.domains,
      },
      summary: {
        registryCandidates: report.candidateCount,
        displayedCandidates: report.evaluations.length,
        excludedUnrelatedCandidates: 0,
      },
      discovery,
      recommendation: {
        status: legacyStatus(report),
        ...(report.topCandidateId
          ? { candidateId: report.topCandidateId }
          : {}),
        alternativeCandidateIds: report.alternativeCandidateIds,
        reasons: report.recommendationReasons,
        message: report.recommendationMessage,
      },
      candidates: report.evaluations.map((evaluation) =>
        legacyCandidate(evaluation, report.topCandidateId),
      ),
      safety: {
        publisherOwnershipVerified: false,
        runtimeCompatibilityVerified: false,
        installedOrExecuted: false,
      },
    });
    const compact = successResponse("search", {
      schemaVersion: 3,
      service: {
        name: report.service.canonicalName,
        domain: report.service.domain,
      },
      summary: {
        discoveredCandidates: report.candidateCount,
        matchedCandidates: report.evaluations.filter(
          (evaluation) => evaluation.relevance !== "Unrelated / false positive",
        ).length,
        returnedCandidates: report.evaluations.length,
        omittedCandidates: 0,
        excludedUnrelatedCandidates: 0,
      },
      discovery,
      recommendation: {
        status: report.recommendationStatus,
        ...(report.topCandidateId
          ? { candidateId: report.topCandidateId }
          : {}),
        alternativeCandidateIds: report.alternativeCandidateIds,
      },
      candidates: report.evaluations.map((evaluation) =>
        toSearchJson(evaluation),
      ),
      safety: {
        publisherOwnershipVerified: false,
        runtimeCompatibilityVerified: false,
        capabilitiesVerified: false,
        securityAudited: false,
        installedOrExecuted: false,
      },
    });
    const before = Buffer.byteLength(JSON.stringify(legacy, null, 2));
    const after = Buffer.byteLength(JSON.stringify(compact, null, 2));

    expect(report.evaluations).toHaveLength(5);
    expect(after).toBeLessThan(Math.floor(before * 0.7));
    expect(
      (
        compact.data as {
          candidates: Array<{
            capabilities: { inferredFromDescription: string[] };
          }>;
        }
      ).candidates[0]?.capabilities.inferredFromDescription.length,
    ).toBeGreaterThan(0);
  });
});
