import type { CandidateEvaluation } from "../models/candidate-evaluation.js";
import { assessCandidateSecurity } from "../discovery/evaluate-candidates.js";

const MAX_DESCRIPTION_LENGTH = 260;

export function safeTerminalText(value: string, maxLength = MAX_DESCRIPTION_LENGTH): string {
  return value
    // Registry-sourced control bytes are stripped before terminal rendering.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function printCandidate(evaluation: CandidateEvaluation): void {
  printCandidateHeading(evaluation.candidate);
  console.log(`  Relevance: ${evaluation.relevance}`);
  console.log(`  Match confidence: ${evaluation.confidence}`);
  console.log(`  Integration suitability: ${evaluation.suitability}`);
  console.log(`  Evidence quality: ${evaluation.evidenceQuality}`);
  console.log(`  Operational friction: ${evaluation.operationalFriction}`);
  console.log(`  Hosting assessment: ${safeTerminalText(evaluation.hostingAssessment, 180)}`);
  for (const item of evaluation.evidence.filter((entry) =>
    entry.dimension === "relevance" || entry.dimension === "confidence",
  )) {
    console.log(`  Evidence: ${safeTerminalText(item.description, 220)} [${item.source}]`);
  }
  printCandidateDetails(evaluation.candidate, evaluation.trust, evaluation.capabilities, evaluation.evidence);
  for (const reason of evaluation.suitabilityReasons) console.log(`  Suitability evidence: ${safeTerminalText(reason, 220)}`);
  for (const signal of evaluation.maintenanceSignals) console.log(`  Maintenance signal: ${safeTerminalText(signal, 180)}`);
  if (evaluation.duplicate) {
    console.log(`  Duplicate relationship: ${evaluation.duplicate.confidence} with ${evaluation.duplicate.relatedIdentifiers.join(", ")}`);
    for (const reason of evaluation.duplicate.reasons) console.log(`    Evidence: ${safeTerminalText(reason, 180)}`);
    if (evaluation.duplicate.versionNote) console.log(`    ${safeTerminalText(evaluation.duplicate.versionNote, 180)}`);
  }
}

export function printCandidateCompact(evaluation: CandidateEvaluation, label = ""): void {
  const candidate = evaluation.candidate;
  const title = safeTerminalText(candidate.title ?? candidate.name, 100);
  console.log(`${label}${title}`);
  const deployment = candidate.operational.deploymentModels.length
    ? candidate.operational.deploymentModels.join(" + ")
    : "Deployment unknown";
  console.log(`  ${evaluation.relevance} · ${evaluation.confidence} match · ${deployment} · Trust ${evaluation.trust}`);
  if (candidate.description) console.log(`  ${safeTerminalText(candidate.description, 150)}`);
  if (candidate.operational.authentication === "Unknown") console.log("  Setup: authentication requirements unknown");
  if (evaluation.capabilities.length) {
    console.log(`  Described capabilities: ${evaluation.capabilities.map((item) => item.name).slice(0, 5).join(", ")} (inferred)`);
  }
  const secrets = candidate.operational.configurationInputs.filter((input) => input.secret === true);
  if (secrets.length) console.log(`  Setup: sensitive inputs ${secrets.map((input) => safeTerminalText(input.name, 50)).join(", ")}`);
  if (evaluation.securityRisk === "Elevated concern" || evaluation.securityRisk === "Sensitive credential requirement") {
    console.log(`  Security: ${evaluation.securityRisk} — ${evaluation.securityFindings[0] ?? "review required inputs"}`);
  } else if (evaluation.securityFindings.some((finding) => finding.includes("remote endpoint"))) {
    console.log("  Security: remote service dependency (endpoint details in inspect)");
  }
}

export function printRecommendationCompact(evaluation: CandidateEvaluation): void {
  const candidate = evaluation.candidate;
  const title = safeTerminalText(candidate.title ?? candidate.name, 90);
  const deployment = candidate.operational.deploymentModels.join(" + ") || "deployment unknown";
  console.log(`${title} · ${evaluation.relevance} · ${evaluation.confidence} confidence · ${deployment} · trust ${evaluation.trust}`);
  if (candidate.description) console.log(`What: ${safeTerminalText(candidate.description, 160)}`);
  if (evaluation.capabilities.length) console.log(`Capabilities (inferred): ${evaluation.capabilities.map((claim) => claim.name).slice(0, 5).join(", ")}`);
  const runtime = candidate.operational.packages.map((pkg) => pkg.runtimeHint).filter((value): value is string => Boolean(value));
  const inputNames = candidate.operational.configurationInputs
    .filter((input) => input.required !== false || input.secret === true)
    .map((input) => safeTerminalText(input.name, 45));
  const setupParts = [
    runtime.length ? `runtime ${[...new Set(runtime)].join(", ")}` : "",
    candidate.operational.authentication === "Unknown" ? "authentication unknown" : candidate.operational.authentication,
    inputNames.length ? `declared inputs ${[...new Set(inputNames)].join(", ")}` : "",
  ].filter(Boolean);
  console.log(`Setup: ${setupParts.join(" · ") || "requirements unknown"}`);
  if (evaluation.securityRisk === "Elevated concern" || evaluation.securityRisk === "Sensitive credential requirement") {
    console.log(`Security warning: ${evaluation.securityRisk} — ${evaluation.securityFindings[0] ?? "review declared requirements"}`);
  } else if (evaluation.securityFindings.some((finding) => finding.includes("remote endpoint"))) {
    console.log(`Security: ${safeTerminalText(evaluation.hostingAssessment, 130)}`);
  }
}

export function printAlternativeCompact(evaluation: CandidateEvaluation): void {
  const candidate = evaluation.candidate;
  const title = safeTerminalText(candidate.title ?? candidate.name, 80);
  const deployment = candidate.operational.deploymentModels.length
    ? candidate.operational.deploymentModels.join(" + ")
    : "deployment unknown";
  const hosted = evaluation.hostingAssessment.startsWith("Remote endpoint on a known service domain")
    ? " · service-domain endpoint, operator/auth unknown"
    : "";
  console.log(`  ${title} · ${evaluation.relevance} · ${evaluation.confidence} confidence · ${deployment} · trust ${evaluation.trust}${hosted}`);
}

export function printCandidateHeading(candidate: CandidateEvaluation["candidate"]): void {
  console.log(safeTerminalText(candidate.title ?? candidate.name));
}

export function printCandidateDetails(
  candidate: CandidateEvaluation["candidate"],
  trust: CandidateEvaluation["trust"],
  capabilities: CandidateEvaluation["capabilities"],
  evidence: CandidateEvaluation["evidence"],
): void {
  const security = assessCandidateSecurity(candidate);
  console.log(`  Registry identifier: ${safeTerminalText(candidate.registryIdentifier)}`);
  if (candidate.registryNamespace) {
    console.log(`  Registry namespace (not a verified publisher): ${safeTerminalText(candidate.registryNamespace)}`);
  }
  console.log(`  Source: ${candidate.sourceRegistry}`);
  console.log(`  Trust: ${trust}`);
  if (capabilities.length > 0) {
    console.log(
      `  Claimed capabilities (inferred from description): ${capabilities.map((item) => item.name).join(", ")}`,
    );
  } else {
    console.log("  Capabilities: Unknown");
  }

  if (candidate.description) {
    console.log(`  Description (publisher-provided): ${safeTerminalText(candidate.description)}`);
  }
  if (candidate.repositoryUrl) console.log(`  Repository: ${safeTerminalText(candidate.repositoryUrl)}`);
  if (candidate.websiteUrl) console.log(`  Website: ${safeTerminalText(candidate.websiteUrl)}`);
  if (candidate.version) console.log(`  Version: ${safeTerminalText(candidate.version)}`);
  if (candidate.registryStatus) console.log(`  Registry status: ${safeTerminalText(candidate.registryStatus)}`);

  const { operational } = candidate;
  console.log(
    `  Deployment: ${operational.deploymentModels.length ? operational.deploymentModels.join(", ") : "Unknown"}`,
  );
  console.log(`  Transport: ${operational.transports.length ? operational.transports.join(", ") : "Unknown"}`);
  if (operational.packages.length > 0) {
    for (const pkg of operational.packages) {
      const parts = [pkg.registryType, pkg.identifier, pkg.version, pkg.runtimeHint].filter(
        (part): part is string => Boolean(part),
      );
      console.log(`  Package metadata: ${parts.map((part) => safeTerminalText(part)).join(" · ")}`);
    }
  }
  if (operational.remoteEndpoints.length > 0) {
    for (const endpoint of operational.remoteEndpoints) {
      console.log(`  Remote endpoint (registry-provided): ${safeTerminalText(endpoint)}`);
    }
  }
  if (operational.configurationInputs.length > 0) {
    console.log("  Configuration inputs (registry-provided):");
    for (const input of operational.configurationInputs) {
      const flags = [
        input.required === undefined ? "required status unknown" : input.required ? "required" : "optional",
        input.secret === true ? "secret" : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      console.log(`    ${safeTerminalText(input.name)} (${flags})`);
      if (input.description) console.log(`      ${safeTerminalText(input.description, 180)}`);
    }
  }
  console.log(`  Authentication: ${operational.authentication}`);
  if (operational.configurationInputs.some((input) => input.secret === true)) {
    console.log("  Authentication note: Registry declares a secret input; the authentication protocol is unknown.");
  }
  console.log(`  Client compatibility: ${operational.clientCompatibility}`);
  console.log(`  Setup complexity: ${operational.setupComplexity}`);
  console.log(`  Security risk: ${security.risk}`);
  for (const finding of security.findings) console.log(`  Security note: ${safeTerminalText(finding, 220)}`);
  for (const item of evidence.filter((entry) => entry.dimension === "trust")) {
    console.log(`  Trust evidence: ${safeTerminalText(item.description, 220)}`);
  }
  console.log(`  Registry record: ${safeTerminalText(candidate.sourceRecordUrl)}`);
}

export function toSearchJson(
  evaluation: CandidateEvaluation,
  recommendedCandidateId?: string,
): Record<string, unknown> {
  return {
    registryIdentifier: evaluation.candidate.registryIdentifier,
    name: evaluation.candidate.name,
    ...(evaluation.candidate.title ? { title: evaluation.candidate.title } : {}),
    ...(evaluation.candidate.description ? { description: evaluation.candidate.description } : {}),
    ...(evaluation.candidate.version ? { version: evaluation.candidate.version } : {}),
    source: evaluation.candidate.sourceRegistry,
    sourceRecordUrl: evaluation.candidate.sourceRecordUrl,
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
    operational: evaluation.candidate.operational,
    recommended: evaluation.candidate.registryIdentifier === recommendedCandidateId,
  };
}
