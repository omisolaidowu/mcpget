import type { Command } from "commander";
import { classifyCandidateTrust, evaluateCandidate, evaluateCandidates, inferCapabilities } from "../../discovery/evaluate-candidates.js";
import type { ServiceIdentity } from "../../models/server-candidate.js";
import type { CandidateEvaluation, RecommendationReport } from "../../models/candidate-evaluation.js";
import { RegistryError } from "../../discovery/registry/official-registry-adapter.js";
import { OfficialRegistryAdapter } from "../../discovery/registry/official-registry-adapter.js";
import { resolveServiceIdentity, UrlResolutionError } from "../../discovery/url-resolver.js";
import { printCandidate, printCandidateDetails, printCandidateHeading, safeTerminalText } from "../output.js";
import { InstallationStateStore } from "../../installers/state-store.js";

interface CandidateInspector {
  getByIdentifier(identifier: string): ReturnType<OfficialRegistryAdapter["getByIdentifier"]>;
  searchByName?(name: string): ReturnType<OfficialRegistryAdapter["searchByName"]>;
}

export function registerInspectCommand(
  program: Command,
  inspector: CandidateInspector = new OfficialRegistryAdapter(),
): void {
  const command = program
    .command("inspect <server-id>")
    .description("Inspect Registry metadata and evaluate it for an optional service")
    .option("--for <url>", "evaluate relevance and confidence against a service URL/domain")
    .option("--json", "print stable JSON output");

  command.action(async (identifier: string) => {
    try {
      const installed = await new InstallationStateStore().all().catch(() => []);
      const localRecords = installed.filter((item) => item.id === identifier || item.serverIdentifier === identifier || item.configName === identifier);
      for (const record of localRecords) {
        console.log(`Installation state for ${safeTerminalText(record.displayName)} (${record.client}, ${record.strategy}):`);
        for (const [state, step] of Object.entries(record.states)) console.log(`  ${state}: ${step.status} — ${safeTerminalText(step.detail, 180)}`);
      }
      const candidate = await inspector.getByIdentifier(identifier);
      const options = command.opts();
      const target = typeof options.for === "string" ? options.for : undefined;
      const identity = target ? resolveServiceIdentity(target) : undefined;
      if (identity?.isLocalOrIp) {
        throw new UrlResolutionError("Registry evaluation requires a public service domain.");
      }
      let evaluation = identity ? evaluateCandidate(identity, candidate) : undefined;
      let recommendation: { status: string; message: string; reasons: string[] } | undefined;
      if (identity && inspector.searchByName) {
        const related = await inspector.searchByName(identity.registrySearchTerms[0] ?? identity.productName);
        if (related.some((item) => item.registryIdentifier === candidate.registryIdentifier)) {
          const report = evaluateCandidates(identity, [...related, candidate]);
          evaluation = report.evaluations.find((item) => item.candidate.registryIdentifier === candidate.registryIdentifier) ?? evaluation;
          const reasons = evaluation ? inspectionRecommendationReasons(evaluation, report) : [];
          recommendation = {
            status: report.recommendationStatus === "similar candidates" && report.alternativeCandidateIds.includes(candidate.registryIdentifier)
              ? "Similarly suitable; no clear winner"
              : report.recommendedCandidateId === candidate.registryIdentifier
                ? `Recommended (${report.recommendationStatus})`
                : report.recommendedCandidateId
                  ? "Not selected as the top general-purpose candidate"
                  : "No confident recommendation",
            message: report.recommendationMessage,
            reasons,
          };
        }
      }
      const trustResult = evaluation ? undefined : classifyCandidateTrust(candidate);
      const trust = evaluation?.trust ?? trustResult!.classification;
      const evidence = evaluation?.evidence ?? trustResult!.evidence;
      const capabilities = evaluation?.capabilities ?? inferCapabilities(candidate.description ?? "");

      if (options.json === true) {
        const payload = {
          schemaVersion: 1,
          server: {
            registryIdentifier: candidate.registryIdentifier,
            name: candidate.name,
            ...(candidate.title ? { title: candidate.title } : {}),
            ...(candidate.description ? { description: candidate.description } : {}),
            ...(candidate.version ? { version: candidate.version } : {}),
            ...(candidate.repositoryUrl ? { repositoryUrl: candidate.repositoryUrl } : {}),
            ...(candidate.websiteUrl ? { websiteUrl: candidate.websiteUrl } : {}),
            source: candidate.sourceRegistry,
            sourceRecordUrl: candidate.sourceRecordUrl,
            registryStatus: candidate.registryStatus ?? "Unknown",
          },
          evaluation: {
            ...(identity
              ? {
                  service: serviceJson(identity),
                  relevance: evaluation?.relevance,
                  confidence: evaluation?.confidence,
                }
              : { relevance: "Not assessed", confidence: "Not assessed" }),
            trust,
            ...(evaluation ? {
              suitability: evaluation.suitability,
              evidenceQuality: evaluation.evidenceQuality,
              operationalFriction: evaluation.operationalFriction,
              hostingAssessment: evaluation.hostingAssessment,
              securityRisk: evaluation.securityRisk,
              securityFindings: evaluation.securityFindings,
              maintenanceSignals: evaluation.maintenanceSignals,
              ...(evaluation.duplicate ? { duplicate: evaluation.duplicate } : {}),
              recommendation: recommendation ?? { status: "Not assessed against the search result set", reasons: [] },
            } : {}),
            capabilities,
            evidence,
          },
          operational: candidate.operational,
          safety: {
            installedOrExecuted: false,
            candidateLinksFetched: false,
          },
        };
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log("MCPGet — Candidate Inspection");
      if (identity) {
        console.log(`Service: ${safeTerminalText(identity.canonicalName)}`);
        console.log(`Domain: ${safeTerminalText(identity.domain)}`);
      }
      if (evaluation) {
        console.log(`Recommendation: ${safeTerminalText(recommendation?.status ?? "Not assessed against the search result set")}`);
        for (const reason of recommendation?.reasons.slice(0, 3) ?? []) {
          console.log(`  Recommendation evidence: ${safeTerminalText(reason, 180)}`);
        }
        printCandidate(evaluation);
      } else {
        printCandidateHeading(candidate);
        console.log("  Relevance: Not assessed (use --for <url> to assess against a service)");
        console.log("  Match confidence: Not assessed");
        printCandidateDetails(candidate, trust, capabilities, evidence);
      }
      console.log("No MCP server has been installed, executed, or contacted.");
    } catch (error) {
      const message =
        error instanceof UrlResolutionError || error instanceof RegistryError
          ? error.message
          : error instanceof Error
            ? error.message
            : "An unexpected error occurred during inspection.";
      console.error(`Inspection failed: ${safeTerminalText(message)}`);
      process.exitCode = 1;
    }
  });
}

function serviceJson(identity: ServiceIdentity): Record<string, unknown> {
  return {
    name: identity.canonicalName,
    domain: identity.domain,
    aliases: identity.productAliases,
    domains: identity.domains,
  };
}

function inspectionRecommendationReasons(candidate: CandidateEvaluation, report: RecommendationReport): string[] {
  if (report.recommendationStatus === "similar candidates" &&
      report.alternativeCandidateIds.includes(candidate.candidate.registryIdentifier)) {
    return ["This candidate is similarly suitable; available metadata does not establish a clear winner."];
  }
  if (report.recommendedCandidateId === candidate.candidate.registryIdentifier) {
    return candidate.suitabilityReasons.slice(0, 3);
  }
  const winner = report.evaluations.find((item) => item.candidate.registryIdentifier === report.recommendedCandidateId);
  const reasons: string[] = [];
  if (!candidate.recommendationEligible) {
    reasons.push(`Not eligible for a general-purpose recommendation: ${candidate.capabilities.length} distinct capability areas are described; at least two are required.`);
  }
  if (winner) {
    if (winner.capabilities.length > candidate.capabilities.length) {
      reasons.push(`The selected candidate describes ${winner.capabilities.length} capability areas; this record describes ${candidate.capabilities.length}.`);
    }
    if (winner.operationalFriction === "Low" && candidate.operationalFriction !== "Low") {
      reasons.push("The selected candidate has fewer declared setup requirements.");
    }
    if (winner.evidenceQuality === "Strong" && candidate.evidenceQuality !== "Strong") {
      reasons.push("The selected candidate has more complete Registry metadata.");
    }
    if (!reasons.length) reasons.push("The selected candidate ranks higher on available functional and operational evidence; maintainer trust is not used as a quality score.");
  } else if (!reasons.length) {
    reasons.push("No candidate has enough evidence for a confident general-purpose recommendation.");
  }
  return reasons.slice(0, 3);
}
