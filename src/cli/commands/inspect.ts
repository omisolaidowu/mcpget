import type { Command } from "commander";
import {
  classifyCandidateTrust,
  evaluateCandidate,
  evaluateCandidates,
  inferCapabilities,
} from "../../discovery/evaluate-candidates.js";
import type { ServiceIdentity } from "../../models/server-candidate.js";
import type {
  CandidateEvaluation,
  RecommendationReport,
} from "../../models/candidate-evaluation.js";
import { RegistryError } from "../../discovery/registry/official-registry-adapter.js";
import { OfficialRegistryAdapter } from "../../discovery/registry/official-registry-adapter.js";
import {
  resolveServiceIdentity,
  UrlResolutionError,
} from "../../discovery/url-resolver.js";
import {
  printCandidate,
  printCandidateDetails,
  printCandidateHeading,
  safeTerminalText,
} from "../output.js";
import { InstallationStateStore } from "../../installers/state-store.js";
import { redactEndpointCredentials } from "../../security/remote-endpoint.js";
import {
  CliError,
  EXIT_CODES,
  failureResponse,
  printJson,
  successResponse,
} from "../output.js";

interface CandidateInspector {
  getByIdentifier(
    identifier: string,
  ): ReturnType<OfficialRegistryAdapter["getByIdentifier"]>;
  searchByName?(
    name: string,
  ): ReturnType<OfficialRegistryAdapter["searchByName"]>;
}

export function registerInspectCommand(
  program: Command,
  inspector: CandidateInspector = new OfficialRegistryAdapter(),
): void {
  const command = program
    .command("inspect <server-id>")
    .description(
      "Inspect Registry metadata and evaluate it for an optional service",
    )
    .option(
      "--for <url>",
      "evaluate relevance and confidence against a service URL/domain",
    )
    .option("--json", "print stable JSON output");

  command.action(async (identifier: string) => {
    const options = command.opts();
    const json = options.json === true;
    try {
      const installed = await new InstallationStateStore()
        .all()
        .catch(() => []);
      const localRecords = installed.filter(
        (item) =>
          item.id === identifier ||
          item.serverIdentifier === identifier ||
          item.configName === identifier,
      );
      if (!json)
        for (const record of localRecords) {
          console.log(
            `Installation state for ${safeTerminalText(record.displayName)} (${record.client}, ${record.strategy}):`,
          );
          for (const [state, step] of Object.entries(record.states))
            console.log(
              `  ${state}: ${step.status} — ${safeTerminalText(step.detail, 180)}`,
            );
        }
      const candidate = await inspector.getByIdentifier(identifier);
      const target = typeof options.for === "string" ? options.for : undefined;
      const identity = target ? resolveServiceIdentity(target) : undefined;
      if (identity?.isLocalOrIp) {
        throw new UrlResolutionError(
          "Registry evaluation requires a public service domain.",
        );
      }
      let evaluation = identity
        ? evaluateCandidate(identity, candidate)
        : undefined;
      let recommendation:
        | {
            state: string;
            status: string;
            message: string;
            reasons: string[];
          }
        | undefined;
      if (identity && inspector.searchByName) {
        const related = await inspector.searchByName(
          identity.registrySearchTerms[0] ?? identity.productName,
        );
        if (
          related.some(
            (item) => item.registryIdentifier === candidate.registryIdentifier,
          )
        ) {
          const report = evaluateCandidates(identity, [...related, candidate]);
          evaluation =
            report.evaluations.find(
              (item) =>
                item.candidate.registryIdentifier ===
                candidate.registryIdentifier,
            ) ?? evaluation;
          const reasons = evaluation
            ? inspectionRecommendationReasons(evaluation, report)
            : [];
          recommendation = {
            state: report.recommendationStatus,
            status:
              report.recommendationStatus === "similar_candidates" &&
              report.alternativeCandidateIds.includes(
                candidate.registryIdentifier,
              )
                ? "Similarly suitable; no clear winner"
                : report.topCandidateId === candidate.registryIdentifier &&
                    report.recommendationStatus === "recommended"
                  ? "Recommended for consideration; not independently verified"
                  : report.topCandidateId === candidate.registryIdentifier
                    ? "Top-ranked candidate; not an endorsement"
                    : report.topCandidateId
                      ? "Not selected as the top general-purpose candidate"
                      : "No recommendation",
            message: report.recommendationMessage,
            reasons,
          };
        }
      }
      const trustResult = evaluation
        ? undefined
        : classifyCandidateTrust(candidate);
      const trust = evaluation?.trust ?? trustResult!.classification;
      const evidence = evaluation?.evidence ?? trustResult!.evidence;
      const capabilities =
        evaluation?.capabilities ??
        inferCapabilities(candidate.description ?? "");

      if (options.json === true) {
        const payload: Record<string, unknown> = {
          schemaVersion: 1,
          server: {
            registryIdentifier: candidate.registryIdentifier,
            name: candidate.name,
            ...(candidate.title ? { title: candidate.title } : {}),
            ...(candidate.description
              ? { description: candidate.description }
              : {}),
            ...(candidate.version ? { version: candidate.version } : {}),
            ...(candidate.repositoryUrl
              ? {
                  repositoryUrl: redactEndpointCredentials(
                    candidate.repositoryUrl,
                  ),
                }
              : {}),
            ...(candidate.websiteUrl
              ? { websiteUrl: redactEndpointCredentials(candidate.websiteUrl) }
              : {}),
            source: safeTerminalText(candidate.sourceRegistry, 80),
            sourceRecordUrl: redactEndpointCredentials(
              candidate.sourceRecordUrl,
            ),
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
            ...(evaluation
              ? {
                  suitability: evaluation.suitability,
                  evidenceQuality: evaluation.evidenceQuality,
                  metadataCompleteness: evaluation.evidenceQuality,
                  metadataCompletenessNote:
                    "Registry field presence only; content, capabilities, trust, and security are not independently verified.",
                  operationalFriction: evaluation.operationalFriction,
                  hostingAssessment: evaluation.hostingAssessment,
                  securityRisk: evaluation.securityRisk,
                  securityFindings: evaluation.securityFindings,
                  maintenanceSignals: evaluation.maintenanceSignals,
                  ...(evaluation.duplicate
                    ? { duplicate: evaluation.duplicate }
                    : {}),
                  recommendation: recommendation ?? {
                    state: "not_assessed",
                    status: "Not assessed against the search result set",
                    reasons: [],
                  },
                }
              : {}),
            capabilities,
            evidence,
          },
          operational: {
            ...candidate.operational,
            remoteEndpoints: candidate.operational.remoteEndpoints.map(
              redactEndpointCredentials,
            ),
          },
          safety: {
            installedOrExecuted: false,
            candidateLinksFetched: false,
          },
        };
        payload.installedRecords = localRecords.map((record) => ({
          displayName: record.displayName,
          client: record.client,
          strategy: record.strategy,
          states: record.states,
        }));
        printJson(successResponse("inspect", payload));
        return;
      }

      console.log("MCPGet — Candidate Inspection");
      if (identity) {
        console.log(`Service: ${safeTerminalText(identity.canonicalName)}`);
        console.log(`Domain: ${safeTerminalText(identity.domain)}`);
      }
      if (evaluation) {
        console.log(
          `Recommendation: ${safeTerminalText(recommendation?.status ?? "Not assessed against the search result set")}`,
        );
        for (const reason of recommendation?.reasons.slice(0, 3) ?? []) {
          console.log(
            `  Recommendation evidence: ${safeTerminalText(reason, 180)}`,
          );
        }
        printCandidate(evaluation);
      } else {
        printCandidateHeading(candidate);
        console.log(
          "  Relevance: Not assessed (use --for <url> to assess against a service)",
        );
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
      if (error instanceof UrlResolutionError) {
        if (json)
          printJson(
            failureResponse("inspect", new CliError("INVALID_INPUT", message)),
          );
        else console.error(`Inspection failed: ${safeTerminalText(message)}`);
        process.exitCode = EXIT_CODES.invalidInput;
        return;
      }
      if (json)
        printJson(
          failureResponse(
            "inspect",
            new CliError("OPERATIONAL_FAILURE", message),
          ),
        );
      else console.error(`Inspection failed: ${safeTerminalText(message)}`);
      process.exitCode = EXIT_CODES.operationalFailure;
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

function inspectionRecommendationReasons(
  candidate: CandidateEvaluation,
  report: RecommendationReport,
): string[] {
  if (
    report.recommendationStatus === "similar_candidates" &&
    report.alternativeCandidateIds.includes(
      candidate.candidate.registryIdentifier,
    )
  ) {
    return [
      "This candidate is similarly suitable; available metadata does not establish a clear winner.",
    ];
  }
  if (report.topCandidateId === candidate.candidate.registryIdentifier) {
    return candidate.suitabilityReasons.slice(0, 3);
  }
  const winner = report.evaluations.find(
    (item) => item.candidate.registryIdentifier === report.topCandidateId,
  );
  const reasons: string[] = [];
  if (!candidate.recommendationEligible) {
    reasons.push(
      `Not eligible for a general-purpose recommendation: ${candidate.capabilities.length} distinct capability areas are described; at least two are required.`,
    );
  }
  if (winner) {
    if (winner.capabilities.length > candidate.capabilities.length) {
      reasons.push(
        `The selected candidate describes ${winner.capabilities.length} capability areas; this record describes ${candidate.capabilities.length}.`,
      );
    }
    if (
      winner.operationalFriction === "Low" &&
      candidate.operationalFriction !== "Low"
    ) {
      reasons.push(
        "The selected candidate has fewer declared setup requirements.",
      );
    }
    if (
      winner.evidenceQuality === "Strong" &&
      candidate.evidenceQuality !== "Strong"
    ) {
      reasons.push(
        "More Registry fields are present for the selected candidate; this is metadata completeness, not verification.",
      );
    }
    if (!reasons.length)
      reasons.push(
        "The selected candidate ranks higher on available functional and operational evidence; maintainer trust is not used as a quality score.",
      );
  } else if (!reasons.length) {
    reasons.push(
      "No candidate has enough evidence for a confident general-purpose recommendation.",
    );
  }
  return reasons.slice(0, 3);
}
