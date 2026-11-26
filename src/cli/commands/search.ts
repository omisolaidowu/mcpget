import type { Command } from "commander";
import {
  discoverByServiceUrl,
  type CandidateSource,
} from "../../discovery/search-service.js";
import { RegistryError } from "../../discovery/registry/official-registry-adapter.js";
import type { CandidateEvaluation } from "../../models/candidate-evaluation.js";
import { UrlResolutionError } from "../../discovery/url-resolver.js";
import {
  printCandidate,
  printCandidateCompact,
  printRecommendationCompact,
  safeTerminalText,
  toSearchJson,
} from "../output.js";
import {
  CliError,
  EXIT_CODES,
  exitCodeForError,
  failureResponse,
  PARTIAL_DISCOVERY_WARNING,
  printJson,
  successResponse,
} from "../output.js";

const DEFAULT_CANDIDATE_LIMIT = 5;

export function registerSearchCommand(
  program: Command,
  source?: CandidateSource,
): void {
  const command = program
    .command("search <url-or-domain>")
    .description("Evaluate MCP server candidates for a SaaS URL or domain")
    .option("--more", "show an expanded shortlist of candidates")
    .option(
      "--all",
      "include unrelated results (human output includes details)",
    )
    .option(
      "--limit <count>",
      "maximum candidates to display after ranking (default: 5)",
    )
    .option("--json", "print stable JSON output");

  command.action(async (input: string) => {
    const options = command.opts();
    const json = options.json === true;
    try {
      const limit = parseCandidateLimit(options.limit);
      const result = await discoverByServiceUrl(input, source);
      const includeAll = options.all === true;
      const expanded = options.more === true || includeAll;
      const matchedCandidates = result.evaluations.filter(
        (item) => item.relevance !== "Unrelated / false positive",
      );
      const unrelated = result.evaluations.filter(
        (item) => item.relevance === "Unrelated / false positive",
      );
      const candidatesBeforeLimit = includeAll
        ? result.evaluations
        : matchedCandidates;
      const visible = candidatesBeforeLimit.slice(0, limit);
      const counts = {
        discovered: result.candidateCount,
        matched: matchedCandidates.length,
        returned: visible.length,
        omitted: candidatesBeforeLimit.length - visible.length,
        excluded: includeAll ? 0 : unrelated.length,
      };

      if (options.json === true) {
        const data = {
          schemaVersion: 3,
          service: {
            name: result.service.canonicalName,
            domain: result.service.domain,
          },
          summary: {
            discoveredCandidates: counts.discovered,
            matchedCandidates: counts.matched,
            returnedCandidates: counts.returned,
            omittedCandidates: counts.omitted,
            excludedUnrelatedCandidates: counts.excluded,
          },
          discovery: result.discovery,
          recommendation: {
            status: result.recommendationStatus,
            ...(result.topCandidateId
              ? { candidateId: result.topCandidateId }
              : {}),
            alternativeCandidateIds: result.alternativeCandidateIds,
          },
          candidates: visible.map((item) => toSearchJson(item)),
          safety: {
            publisherOwnershipVerified: false,
            runtimeCompatibilityVerified: false,
            capabilitiesVerified: false,
            securityAudited: false,
            installedOrExecuted: false,
          },
        };
        printJson(
          successResponse(
            "search",
            data,
            result.discovery.status === "partial"
              ? [
                  PARTIAL_DISCOVERY_WARNING,
                  ...(visible.length === 0
                    ? [
                        "No useful candidates were retrieved before discovery became incomplete. Try a more specific service name.",
                      ]
                    : []),
                ]
              : [],
          ),
        );
        return;
      }

      printSearchReport(result, visible, counts, expanded, includeAll);
    } catch (error) {
      if (error instanceof CliError) {
        if (json) printJson(failureResponse("search", error));
        else console.error(`Search failed: ${safeTerminalText(error.message)}`);
        process.exitCode = exitCodeForError(error);
        return;
      }
      const message =
        error instanceof UrlResolutionError || error instanceof RegistryError
          ? error.message
          : error instanceof Error
            ? error.message
            : "An unexpected error occurred during discovery.";
      if (error instanceof UrlResolutionError) {
        if (json)
          printJson(
            failureResponse("search", new CliError("INVALID_INPUT", message)),
          );
        else console.error(`Search failed: ${safeTerminalText(message)}`);
        process.exitCode = EXIT_CODES.invalidInput;
        return;
      }
      if (json)
        printJson(
          failureResponse(
            "search",
            new CliError("OPERATIONAL_FAILURE", message),
          ),
        );
      else console.error(`Search failed: ${safeTerminalText(message)}`);
      process.exitCode = EXIT_CODES.operationalFailure;
    }
  });
}

function parseCandidateLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_CANDIDATE_LIMIT;
  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  ) {
    throw new CliError(
      "INVALID_INPUT",
      "--limit must be a positive safe integer.",
    );
  }
  return Number(value);
}

function printSearchReport(
  result: Awaited<ReturnType<typeof discoverByServiceUrl>>,
  visible: CandidateEvaluation[],
  counts: {
    discovered: number;
    matched: number;
    returned: number;
    omitted: number;
    excluded: number;
  },
  expanded: boolean,
  includeAll: boolean,
): void {
  console.log("MCPGet — Integration Intelligence");
  if (result.discovery.status === "partial") {
    console.log(`\nWARNING: ${PARTIAL_DISCOVERY_WARNING}`);
    if (visible.length === 0) {
      console.log(
        "No useful candidates were retrieved before discovery became incomplete. Try a more specific service name.",
      );
    }
  }
  console.log(`Service: ${safeTerminalText(result.service.canonicalName)}`);
  console.log(
    `Candidates: ${counts.discovered} discovered · ${counts.matched} matched · ${counts.returned} returned · ${counts.omitted} omitted by limit · ${counts.excluded} unrelated excluded`,
  );

  const topCandidate = visible.find(
    (item) => item.candidate.registryIdentifier === result.topCandidateId,
  );
  const alternatives =
    topCandidate || result.recommendationStatus === "similar_candidates"
      ? collapseDuplicateAlternatives(
          result.alternativeCandidateIds
            .map((id) =>
              visible.find((item) => item.candidate.registryIdentifier === id),
            )
            .filter((item): item is CandidateEvaluation => Boolean(item)),
          topCandidate,
        )
      : [];
  const alternativeIds = new Set(
    alternatives.map((item) => item.candidate.registryIdentifier),
  );
  const reviewCandidates = visible.filter(
    (item) =>
      item.relevance !== "Unrelated / false positive" &&
      item !== topCandidate &&
      !alternativeIds.has(item.candidate.registryIdentifier),
  );
  const relatedCandidates = topCandidate
    ? reviewCandidates.filter((item) => item.relevance !== "Direct integration")
    : [];
  const otherReviewCandidates = topCandidate
    ? reviewCandidates.filter((item) => item.relevance === "Direct integration")
    : [];
  const unrelatedCandidates = includeAll
    ? visible.filter((item) => item.relevance === "Unrelated / false positive")
    : [];
  if (topCandidate) {
    const isRecommended = result.recommendationStatus === "recommended";
    console.log(
      isRecommended
        ? "\nRECOMMENDED FOR CONSIDERATION — Registry assessment only"
        : "\nTOP CANDIDATE — not an endorsement",
    );
    if (includeAll) printCandidate(topCandidate);
    else if (expanded) printCandidateCompact(topCandidate);
    else printRecommendationCompact(topCandidate);
    console.log("Why ranked first:");
    const deploymentAlternative = alternatives.find(
      (item) =>
        item.candidate.operational.deploymentModels.includes(
          "Remote endpoint",
        ) !==
        topCandidate.candidate.operational.deploymentModels.includes(
          "Remote endpoint",
        ),
    );
    for (const reason of selectedReasons(
      topCandidate,
      deploymentAlternative ?? alternatives[0],
    ).slice(0, 3))
      console.log(`  • ${safeTerminalText(reason, 220)}`);
    const duplicatePeers = topCandidate.duplicate?.relatedIdentifiers;
    if (duplicatePeers?.length) {
      console.log(
        `  Possible duplicate registry entries: ${duplicatePeers.map((id) => safeTerminalText(id, 100)).join(", ")} (${safeTerminalText(topCandidate.duplicate?.confidence.toLowerCase() ?? "unknown", 30)})`,
      );
      if (topCandidate.duplicate?.versionNote)
        console.log(
          `  ${safeTerminalText(topCandidate.duplicate.versionNote, 200)}`,
        );
    }
  } else if (result.recommendationStatus === "similar_candidates") {
    console.log(
      "\nSIMILAR CANDIDATES — available Registry evidence does not establish a clear winner.",
    );
  } else {
    console.log(
      `\nNO RECOMMENDATION\n${safeTerminalText(result.recommendationMessage)}`,
    );
  }

  if (alternatives.length)
    printCandidateGroup("Alternatives", alternatives, expanded, includeAll);
  if (topCandidate) {
    if (relatedCandidates.length)
      printCandidateGroup(
        "Related alternatives for review",
        relatedCandidates,
        expanded,
        includeAll,
      );
    if (otherReviewCandidates.length)
      printCandidateGroup(
        "Other candidates for review",
        otherReviewCandidates,
        expanded,
        includeAll,
      );
  } else if (reviewCandidates.length) {
    printCandidateGroup(
      "Candidates for review",
      reviewCandidates,
      expanded,
      includeAll,
    );
  }
  if (unrelatedCandidates.length)
    printCandidateGroup(
      "Unrelated candidates (--all)",
      unrelatedCandidates,
      true,
      true,
    );
  if (!expanded && (alternatives.length || reviewCandidates.length))
    console.log("\nUse --more for expanded candidate details.");
  if (counts.omitted > 0)
    console.log(
      `\n${counts.omitted} additional visible candidates were omitted by --limit; increase it to see more.`,
    );
  if (counts.discovered === 0)
    console.log("\nNo candidates were returned by the Registry name search.");
  console.log(
    "\nRegistry descriptions are claims, not verified capabilities. Trust, security, and runtime behavior are not independently verified; no candidate has been installed or executed.",
  );
}

function printCandidateGroup(
  label: string,
  candidates: CandidateEvaluation[],
  expanded: boolean,
  includeAll: boolean,
): void {
  console.log(`\n${label} (${candidates.length})`);
  for (const item of candidates)
    printSearchCandidate(item, expanded, includeAll);
}

function printSearchCandidate(
  item: CandidateEvaluation,
  expanded: boolean,
  includeAll: boolean,
): void {
  if (includeAll) {
    printCandidate(item);
    console.log(
      `  Available installation source: ${availableInstallationSources(item).join(", ")}`,
    );
    return;
  }
  if (expanded) printCandidateCompact(item, "  ");
  else
    console.log(
      `  ${safeTerminalText(item.candidate.title ?? item.candidate.name, 100)}`,
    );
  console.log(
    `    Registry identity: ${safeTerminalText(item.candidate.registryIdentifier, 180)}`,
  );
  console.log(
    `    Available installation source: ${availableInstallationSources(item).join(", ")}`,
  );
  if (!expanded)
    console.log(`    ${item.relevance} · ${item.confidence} match confidence`);
  if (item.duplicate) {
    console.log(
      `    Possible duplicate of ${item.duplicate.relatedIdentifiers.map((id) => safeTerminalText(id, 100)).join(", ")} (${safeTerminalText(item.duplicate.confidence.toLowerCase(), 30)})`,
    );
    if (item.duplicate.versionNote)
      console.log(`    ${safeTerminalText(item.duplicate.versionNote, 180)}`);
  }
}

function availableInstallationSources(item: CandidateEvaluation): string[] {
  const packages = item.candidate.operational.packages.flatMap((pkg) => {
    if (!pkg.registryType || !pkg.identifier) return [];
    const version = pkg.version
      ? ` (version ${safeTerminalText(pkg.version, 60)})`
      : "";
    return [
      `${safeTerminalText(pkg.registryType.toLowerCase(), 40)}:${safeTerminalText(pkg.identifier, 120)}${version}`,
    ];
  });
  const remotes = item.candidate.operational.remoteEndpoints
    .filter((endpoint) => endpoint.startsWith("https://"))
    .map(() => "remote HTTPS endpoint");
  const sources = [...new Set([...packages, ...remotes])];
  return sources.length ? sources : ["None declared"];
}

function collapseDuplicateAlternatives(
  items: CandidateEvaluation[],
  recommended?: CandidateEvaluation,
): CandidateEvaluation[] {
  const seen = new Set<string>();
  const output: CandidateEvaluation[] = [];
  for (const item of items) {
    if (
      recommended?.duplicate &&
      item.duplicate?.groupId === recommended.duplicate.groupId
    )
      continue;
    const key = item.duplicate?.groupId ?? item.candidate.registryIdentifier;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function selectedReasons(
  item: CandidateEvaluation,
  alternative?: CandidateEvaluation,
): string[] {
  const reasons: string[] = [];
  if (
    alternative &&
    item.capabilities.length > alternative.capabilities.length
  ) {
    reasons.push(
      `Description supports more distinct capabilities than ${safeTerminalText(alternative.candidate.title ?? alternative.candidate.name, 55)}`,
    );
  }
  if (
    alternative &&
    item.operationalFriction !== alternative.operationalFriction
  ) {
    const frictionRank = (value: CandidateEvaluation["operationalFriction"]) =>
      value === "Low"
        ? 0
        : value === "Medium"
          ? 1
          : value === "Unknown"
            ? 2
            : 3;
    if (
      frictionRank(item.operationalFriction) <
      frictionRank(alternative.operationalFriction)
    )
      reasons.push(
        "Fewer setup requirements are declared in Registry metadata",
      );
  }
  if (
    alternative &&
    item.securityRisk !== alternative.securityRisk &&
    (alternative.securityRisk === "Elevated concern" ||
      alternative.securityRisk === "Sensitive credential requirement") &&
    item.securityRisk !== "Elevated concern" &&
    item.securityRisk !== "Sensitive credential requirement"
  ) {
    reasons.push(
      "Fewer sensitive or elevated requirements are declared than for the alternative; authentication details remain unknown",
    );
  }
  if (
    item.hostingAssessment.startsWith(
      "Remote endpoint on a known service domain",
    )
  ) {
    reasons.push(
      "Provides a remote endpoint on a known service domain; operator and authentication are unverified",
    );
  }
  if (item.confidence === "High")
    reasons.push("Product association has corroborating Registry signals");
  reasons.push(
    ...item.suitabilityReasons.filter(
      (reason) =>
        reason.startsWith("Classified") ||
        reason.startsWith("Description supports"),
    ),
  );
  if (
    item.securityRisk === "Elevated concern" ||
    item.securityRisk === "Sensitive credential requirement"
  ) {
    reasons.push(`Security review needed: ${item.securityRisk.toLowerCase()}`);
  }
  if (item.trust === "Unverified" || item.trust === "Insufficient evidence")
    reasons.push("Maintainer identity remains unverified");
  return [...new Set(reasons)];
}
