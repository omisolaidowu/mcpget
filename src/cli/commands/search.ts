import type { Command } from "commander";
import { discoverByServiceUrl, type CandidateSource } from "../../discovery/search-service.js";
import { RegistryError } from "../../discovery/registry/official-registry-adapter.js";
import type { CandidateEvaluation } from "../../models/candidate-evaluation.js";
import { UrlResolutionError } from "../../discovery/url-resolver.js";
import { printAlternativeCompact, printCandidate, printCandidateCompact, printRecommendationCompact, safeTerminalText, toSearchJson } from "../output.js";

export function registerSearchCommand(program: Command, source?: CandidateSource): void {
  const command = program
    .command("search <url-or-domain>")
    .description("Evaluate MCP server candidates for a SaaS URL or domain")
    .option("--more", "show an expanded shortlist of candidates")
    .option("--all", "include unrelated results and full candidate details")
    .option("--json", "print stable JSON output");

  command.action(async (input: string) => {
    try {
      const result = await discoverByServiceUrl(input, source);
      const options = command.opts();
      const includeAll = options.all === true;
      const expanded = options.more === true || includeAll;
      const unrelated = result.evaluations.filter((item) => item.relevance === "Unrelated / false positive");
      const visible = includeAll
        ? result.evaluations
        : result.evaluations.filter((item) => item.relevance !== "Unrelated / false positive");

      if (options.json === true) {
        console.log(JSON.stringify({
          schemaVersion: 2,
          service: { name: result.service.canonicalName, domain: result.service.domain, aliases: result.service.productAliases, domains: result.service.domains },
          summary: { registryCandidates: result.candidateCount, displayedCandidates: visible.length, excludedUnrelatedCandidates: includeAll ? 0 : unrelated.length },
          recommendation: {
            status: result.recommendationStatus,
            ...(result.recommendedCandidateId ? { candidateId: result.recommendedCandidateId } : {}),
            alternativeCandidateIds: result.alternativeCandidateIds,
            reasons: result.recommendationReasons,
            message: result.recommendationMessage,
          },
          candidates: visible.map((item) => toSearchJson(item, result.recommendedCandidateId)),
          safety: { publisherOwnershipVerified: false, runtimeCompatibilityVerified: false, installedOrExecuted: false },
        }, null, 2));
        return;
      }

      printSearchReport(result, visible, unrelated.length, expanded, includeAll);
    } catch (error) {
      const message = error instanceof UrlResolutionError || error instanceof RegistryError
        ? error.message
        : error instanceof Error ? error.message : "An unexpected error occurred during discovery.";
      console.error(`Search failed: ${safeTerminalText(message)}`);
      process.exitCode = 1;
    }
  });
}

function printSearchReport(
  result: Awaited<ReturnType<typeof discoverByServiceUrl>>,
  visible: CandidateEvaluation[],
  unrelatedCount: number,
  expanded: boolean,
  includeAll: boolean,
): void {
  console.log("MCPGet — Integration Intelligence");
  console.log(`Service: ${safeTerminalText(result.service.canonicalName)} · ${result.candidateCount} Registry candidates${unrelatedCount ? ` · ${unrelatedCount} unrelated hidden` : ""}`);

  const recommended = visible.find((item) => item.candidate.registryIdentifier === result.recommendedCandidateId);
  const alternatives = collapseDuplicateAlternatives(result.alternativeCandidateIds
    .map((id) => visible.find((item) => item.candidate.registryIdentifier === id))
    .filter((item): item is CandidateEvaluation => Boolean(item)), recommended);
  if (recommended) {
    console.log(`\nRECOMMENDED — ${result.recommendationStatus === "confident" ? "Confident" : "Qualified"}`);
    if (includeAll) printCandidate(recommended);
    else if (expanded) printCandidateCompact(recommended);
    else printRecommendationCompact(recommended);
    console.log("Why selected:");
    const deploymentAlternative = alternatives.find((item) =>
      item.candidate.operational.deploymentModels.includes("Remote endpoint") !==
      recommended.candidate.operational.deploymentModels.includes("Remote endpoint"),
    );
    for (const reason of selectedReasons(recommended, deploymentAlternative ?? alternatives[0]).slice(0, 3)) console.log(`  • ${reason}`);
    const duplicatePeers = recommended.duplicate?.relatedIdentifiers;
    if (duplicatePeers?.length) {
      console.log(`  Possible duplicate registry entries: ${duplicatePeers.join(", ")} (${recommended.duplicate?.confidence.toLowerCase()})`);
      if (recommended.duplicate?.versionNote) console.log(`  ${safeTerminalText(recommended.duplicate.versionNote, 200)}`);
    }
    if (result.recommendationStatus === "similar candidates") {
      console.log("Several candidates appear similarly suitable; compare them with inspect.");
    }
  } else {
    console.log(`\nNO CONFIDENT RECOMMENDATION\n${safeTerminalText(result.recommendationMessage)}`);
  }

  const ids = expanded
    ? visible.filter((item) => item !== recommended)
    : alternatives;
  if (ids.length) {
    console.log(`\n${expanded ? "OTHER CANDIDATES" : "ALTERNATIVES"}`);
    for (const item of ids) {
      if (includeAll) printCandidate(item);
      else if (expanded) printCandidateCompact(item, "  ");
      else printAlternativeCompact(item);
      if (item.duplicate) console.log(`    Possible duplicate of ${item.duplicate.relatedIdentifiers.join(", ")} (${item.duplicate.confidence.toLowerCase()})`);
    }
  }
  const specializedCount = visible.filter((item) => item.relevance === "Specialized integration").length;
  const relatedCount = visible.filter((item) => item.relevance === "Related integration").length;
  const remaining = Math.max(0, visible.length - Number(Boolean(recommended)) - ids.length);
  if (!expanded && (specializedCount || relatedCount || remaining)) {
    const parts = [specializedCount ? `${specializedCount} specialized` : "", relatedCount ? `${relatedCount} related` : "", remaining ? `${remaining} more` : ""].filter(Boolean);
    console.log(`\n${parts.join(" · ")} available. Use --more or inspect <server-id> for details.`);
  }
  if (expanded && unrelatedCount) console.log(`\n${unrelatedCount} unrelated candidate${unrelatedCount === 1 ? "" : "s"} shown above.`);
  if (result.candidateCount === 0) console.log("\nNo candidates were returned by the Registry name search.");
  console.log("\nRegistry descriptions are claims, not verified capabilities; no candidate has been installed or executed.");
}

function collapseDuplicateAlternatives(items: CandidateEvaluation[], recommended?: CandidateEvaluation): CandidateEvaluation[] {
  const seen = new Set<string>();
  const output: CandidateEvaluation[] = [];
  for (const item of items) {
    if (recommended?.duplicate && item.duplicate?.groupId === recommended.duplicate.groupId) continue;
    const key = item.duplicate?.groupId ?? item.candidate.registryIdentifier;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function selectedReasons(item: CandidateEvaluation, alternative?: CandidateEvaluation): string[] {
  const reasons: string[] = [];
  if (alternative && item.capabilities.length > alternative.capabilities.length) {
    reasons.push(`Description supports more distinct capabilities than ${safeTerminalText(alternative.candidate.title ?? alternative.candidate.name, 55)}`);
  }
  if (alternative && item.operationalFriction !== alternative.operationalFriction) {
    const frictionRank = (value: CandidateEvaluation["operationalFriction"]) => value === "Low" ? 0 : value === "Medium" ? 1 : value === "Unknown" ? 2 : 3;
    if (frictionRank(item.operationalFriction) < frictionRank(alternative.operationalFriction)) reasons.push("Fewer setup requirements are declared in Registry metadata");
  }
  if (alternative && item.securityRisk !== alternative.securityRisk &&
      (alternative.securityRisk === "Elevated concern" || alternative.securityRisk === "Sensitive credential requirement") &&
      item.securityRisk !== "Elevated concern" && item.securityRisk !== "Sensitive credential requirement") {
    reasons.push("Fewer sensitive or elevated requirements are declared than for the alternative; authentication details remain unknown");
  }
  if (item.hostingAssessment.startsWith("Remote endpoint on a known service domain")) {
    reasons.push("Provides a remote endpoint on a known service domain; operator and authentication are unverified");
  }
  if (item.confidence === "High") reasons.push("Product association has corroborating Registry signals");
  reasons.push(...item.suitabilityReasons.filter((reason) =>
    reason.startsWith("Classified") || reason.startsWith("Description supports"),
  ));
  if (item.securityRisk === "Elevated concern" || item.securityRisk === "Sensitive credential requirement") {
    reasons.push(`Security review needed: ${item.securityRisk.toLowerCase()}`);
  }
  if (item.trust === "Unverified" || item.trust === "Insufficient evidence") reasons.push("Maintainer identity remains unverified");
  return [...new Set(reasons)];
}
