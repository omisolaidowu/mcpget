import type { CandidateEvaluation } from "../models/candidate-evaluation.js";
import { assessCandidateSecurity } from "../discovery/evaluate-candidates.js";
import { redactEndpointCredentials } from "../security/remote-endpoint.js";

const MAX_DESCRIPTION_LENGTH = 260;

export const EXIT_CODES = {
  success: 0,
  operationalFailure: 1,
  invalidInput: 2,
  unsupportedOperation: 3,
  missingRequiredInput: 4,
  cancelled: 130,
} as const;

export type CliErrorCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_OPERATION"
  | "MISSING_REQUIRED_INPUT"
  | "OPERATIONAL_FAILURE"
  | "CANCELLED";

export class CliError extends Error {
  constructor(
    readonly code: CliErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export interface SuccessResponse {
  schemaVersion: 1;
  ok: true;
  command: string;
  data: unknown;
  warnings: string[];
  partial?: unknown;
}

export interface FailureResponse {
  schemaVersion: 1;
  ok: false;
  command: string;
  error: { code: CliErrorCode; message: string };
  warnings: string[];
  partial?: unknown;
}

export const PARTIAL_DISCOVERY_WARNING =
  "Registry discovery reached the 100-page safety limit. Showing the strongest matches found so far; additional candidates may exist.";

export function successResponse(
  command: string,
  data: unknown,
  warnings: string[] = [],
  partial?: unknown,
): SuccessResponse {
  return {
    schemaVersion: 1,
    ok: true,
    command,
    data,
    warnings,
    ...(partial !== undefined ? { partial } : {}),
  };
}

export function failureResponse(
  command: string,
  error: CliError,
  warnings: string[] = [],
  partial?: unknown,
): FailureResponse {
  return {
    schemaVersion: 1,
    ok: false,
    command,
    error: { code: error.code, message: safeTerminalText(error.message, 500) },
    warnings,
    ...(partial !== undefined ? { partial } : {}),
  };
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function exitCodeForError(error: CliError): number {
  switch (error.code) {
    case "INVALID_INPUT":
      return EXIT_CODES.invalidInput;
    case "UNSUPPORTED_OPERATION":
      return EXIT_CODES.unsupportedOperation;
    case "MISSING_REQUIRED_INPUT":
      return EXIT_CODES.missingRequiredInput;
    case "CANCELLED":
      return EXIT_CODES.cancelled;
    default:
      return EXIT_CODES.operationalFailure;
  }
}

export function safeTerminalText(
  value: string,
  maxLength = MAX_DESCRIPTION_LENGTH,
): string {
  return (
    value
      // Registry-sourced control bytes are stripped before terminal rendering.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength)
  );
}

export function printCandidate(evaluation: CandidateEvaluation): void {
  printCandidateHeading(evaluation.candidate);
  console.log(`  Relevance: ${evaluation.relevance}`);
  console.log(`  Match confidence: ${evaluation.confidence}`);
  console.log(`  Integration suitability: ${evaluation.suitability}`);
  console.log(
    `  Metadata completeness (not verification): ${evaluation.evidenceQuality}`,
  );
  console.log(`  Operational friction: ${evaluation.operationalFriction}`);
  console.log(
    `  Hosting assessment: ${safeTerminalText(evaluation.hostingAssessment, 180)}`,
  );
  for (const item of evaluation.evidence.filter(
    (entry) =>
      entry.dimension === "relevance" || entry.dimension === "confidence",
  )) {
    console.log(
      `  Evidence: ${safeTerminalText(item.description, 220)} [${safeTerminalText(item.source, 80)}]`,
    );
  }
  printCandidateDetails(
    evaluation.candidate,
    evaluation.trust,
    evaluation.capabilities,
    evaluation.evidence,
  );
  for (const reason of evaluation.suitabilityReasons)
    console.log(`  Suitability evidence: ${safeTerminalText(reason, 220)}`);
  for (const signal of evaluation.maintenanceSignals)
    console.log(`  Maintenance signal: ${safeTerminalText(signal, 180)}`);
  if (evaluation.duplicate) {
    console.log(
      `  Duplicate relationship: ${safeTerminalText(evaluation.duplicate.confidence, 30)} with ${evaluation.duplicate.relatedIdentifiers.map((id) => safeTerminalText(id, 100)).join(", ")}`,
    );
    for (const reason of evaluation.duplicate.reasons)
      console.log(`    Evidence: ${safeTerminalText(reason, 180)}`);
    if (evaluation.duplicate.versionNote)
      console.log(
        `    ${safeTerminalText(evaluation.duplicate.versionNote, 180)}`,
      );
  }
}

export function printCandidateCompact(
  evaluation: CandidateEvaluation,
  label = "",
): void {
  const candidate = evaluation.candidate;
  const title = safeTerminalText(candidate.title ?? candidate.name, 100);
  console.log(`${label}${title}`);
  const deployment = candidate.operational.deploymentModels.length
    ? candidate.operational.deploymentModels
        .map((item) => safeTerminalText(item, 60))
        .join(" + ")
    : "Deployment unknown";
  console.log(
    `  ${evaluation.relevance} · ${evaluation.confidence} match · ${deployment} · Trust ${evaluation.trust}`,
  );
  if (candidate.description)
    console.log(`  ${safeTerminalText(candidate.description, 150)}`);
  if (candidate.operational.authentication === "Unknown")
    console.log("  Setup: authentication requirements unknown");
  if (evaluation.capabilities.length) {
    console.log(
      `  Described capabilities: ${evaluation.capabilities
        .map((item) => safeTerminalText(item.name, 60))
        .slice(0, 5)
        .join(", ")} (inferred)`,
    );
  }
  const secrets = candidate.operational.configurationInputs.filter(
    (input) => input.secret === true,
  );
  if (secrets.length)
    console.log(
      `  Setup: sensitive inputs ${secrets.map((input) => safeTerminalText(input.name, 50)).join(", ")}`,
    );
  if (
    evaluation.securityRisk === "Elevated concern" ||
    evaluation.securityRisk === "Sensitive credential requirement"
  ) {
    console.log(
      `  Security: ${evaluation.securityRisk} — ${safeTerminalText(evaluation.securityFindings[0] ?? "review required inputs", 220)}`,
    );
  } else if (
    evaluation.securityFindings.some((finding) =>
      finding.includes("remote endpoint"),
    )
  ) {
    console.log(
      "  Security: remote service dependency (endpoint details in inspect)",
    );
  }
}

export function printRecommendationCompact(
  evaluation: CandidateEvaluation,
): void {
  const candidate = evaluation.candidate;
  const title = safeTerminalText(candidate.title ?? candidate.name, 90);
  const deployment =
    candidate.operational.deploymentModels
      .map((item) => safeTerminalText(item, 60))
      .join(" + ") || "deployment unknown";
  console.log(
    `${title} · ${evaluation.relevance} · ${evaluation.confidence} confidence · ${deployment} · trust ${evaluation.trust}`,
  );
  if (candidate.description)
    console.log(`What: ${safeTerminalText(candidate.description, 160)}`);
  if (evaluation.capabilities.length)
    console.log(
      `Capabilities (inferred): ${evaluation.capabilities
        .map((claim) => safeTerminalText(claim.name, 60))
        .slice(0, 5)
        .join(", ")}`,
    );
  const runtime = candidate.operational.packages
    .map((pkg) => pkg.runtimeHint)
    .filter((value): value is string => Boolean(value))
    .map((value) => safeTerminalText(value, 80));
  const inputNames = candidate.operational.configurationInputs
    .filter((input) => input.required !== false || input.secret === true)
    .map((input) => safeTerminalText(input.name, 45));
  const setupParts = [
    runtime.length ? `runtime ${[...new Set(runtime)].join(", ")}` : "",
    candidate.operational.authentication === "Unknown"
      ? "authentication unknown"
      : safeTerminalText(candidate.operational.authentication, 60),
    inputNames.length
      ? `declared inputs ${[...new Set(inputNames)].join(", ")}`
      : "",
  ].filter(Boolean);
  console.log(`Setup: ${setupParts.join(" · ") || "requirements unknown"}`);
  if (
    evaluation.securityRisk === "Elevated concern" ||
    evaluation.securityRisk === "Sensitive credential requirement"
  ) {
    console.log(
      `Security warning: ${evaluation.securityRisk} — ${safeTerminalText(evaluation.securityFindings[0] ?? "review declared requirements", 220)}`,
    );
  } else if (
    evaluation.securityFindings.some((finding) =>
      finding.includes("remote endpoint"),
    )
  ) {
    console.log(
      `Security: ${safeTerminalText(evaluation.hostingAssessment, 130)}`,
    );
  }
}

export function printAlternativeCompact(evaluation: CandidateEvaluation): void {
  const candidate = evaluation.candidate;
  const title = safeTerminalText(candidate.title ?? candidate.name, 80);
  const deployment = candidate.operational.deploymentModels.length
    ? candidate.operational.deploymentModels
        .map((item) => safeTerminalText(item, 60))
        .join(" + ")
    : "deployment unknown";
  const hosted = evaluation.hostingAssessment.startsWith(
    "Remote endpoint on a known service domain",
  )
    ? " · service-domain endpoint, operator/auth unknown"
    : "";
  console.log(
    `  ${title} · ${evaluation.relevance} · ${evaluation.confidence} confidence · ${deployment} · trust ${evaluation.trust}${hosted}`,
  );
}

export function printCandidateHeading(
  candidate: CandidateEvaluation["candidate"],
): void {
  console.log(safeTerminalText(candidate.title ?? candidate.name));
}

export function printCandidateDetails(
  candidate: CandidateEvaluation["candidate"],
  trust: CandidateEvaluation["trust"],
  capabilities: CandidateEvaluation["capabilities"],
  evidence: CandidateEvaluation["evidence"],
): void {
  const security = assessCandidateSecurity(candidate);
  console.log(
    `  Registry identifier: ${safeTerminalText(candidate.registryIdentifier)}`,
  );
  if (candidate.registryNamespace) {
    console.log(
      `  Registry namespace (not a verified publisher): ${safeTerminalText(candidate.registryNamespace)}`,
    );
  }
  console.log(`  Source: ${safeTerminalText(candidate.sourceRegistry)}`);
  console.log(`  Trust: ${trust}`);
  if (capabilities.length > 0) {
    console.log(
      `  Claimed capabilities (inferred from description): ${capabilities
        .map((item) => safeTerminalText(item.name, 60))
        .join(", ")}`,
    );
  } else {
    console.log("  Capabilities: Unknown");
  }

  if (candidate.description) {
    console.log(
      `  Description (publisher-provided): ${safeTerminalText(candidate.description)}`,
    );
  }
  if (candidate.repositoryUrl)
    console.log(
      `  Repository: ${safeTerminalText(redactEndpointCredentials(candidate.repositoryUrl))}`,
    );
  if (candidate.websiteUrl)
    console.log(
      `  Website: ${safeTerminalText(redactEndpointCredentials(candidate.websiteUrl))}`,
    );
  if (candidate.version)
    console.log(`  Version: ${safeTerminalText(candidate.version)}`);
  if (candidate.registryStatus)
    console.log(
      `  Registry status: ${safeTerminalText(candidate.registryStatus)}`,
    );

  const { operational } = candidate;
  console.log(
    `  Deployment: ${operational.deploymentModels.length ? operational.deploymentModels.map((item) => safeTerminalText(item, 60)).join(", ") : "Unknown"}`,
  );
  console.log(
    `  Transport: ${operational.transports.length ? operational.transports.map((item) => safeTerminalText(item, 60)).join(", ") : "Unknown"}`,
  );
  if (operational.packages.length > 0) {
    for (const pkg of operational.packages) {
      const parts = [
        pkg.registryType,
        pkg.identifier,
        pkg.version,
        pkg.runtimeHint,
      ].filter((part): part is string => Boolean(part));
      console.log(
        `  Package metadata: ${parts.map((part) => safeTerminalText(part)).join(" · ")}`,
      );
    }
  }
  if (operational.remoteEndpoints.length > 0) {
    for (const endpoint of operational.remoteEndpoints) {
      console.log(
        `  Remote endpoint (registry-provided): ${safeTerminalText(redactEndpointCredentials(endpoint))}`,
      );
    }
  }
  if (operational.configurationInputs.length > 0) {
    console.log("  Configuration inputs (registry-provided):");
    for (const input of operational.configurationInputs) {
      const flags = [
        input.required === undefined
          ? "required status unknown"
          : input.required
            ? "required"
            : "optional",
        input.secret === true ? "secret" : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      console.log(`    ${safeTerminalText(input.name)} (${flags})`);
      if (input.description)
        console.log(`      ${safeTerminalText(input.description, 180)}`);
    }
  }
  console.log(
    `  Authentication: ${safeTerminalText(operational.authentication, 60)}`,
  );
  if (operational.configurationInputs.some((input) => input.secret === true)) {
    console.log(
      "  Authentication note: Registry declares a secret input; the authentication protocol is unknown.",
    );
  }
  console.log(
    `  Client compatibility: ${safeTerminalText(operational.clientCompatibility, 60)}`,
  );
  console.log(
    `  Setup complexity: ${safeTerminalText(operational.setupComplexity, 60)}`,
  );
  console.log(`  Security risk: ${security.risk}`);
  for (const finding of security.findings)
    console.log(`  Security note: ${safeTerminalText(finding, 220)}`);
  for (const item of evidence.filter((entry) => entry.dimension === "trust")) {
    console.log(`  Trust evidence: ${safeTerminalText(item.description, 220)}`);
  }
  console.log(
    `  Registry record: ${safeTerminalText(redactEndpointCredentials(candidate.sourceRecordUrl))}`,
  );
}

export function toSearchJson(
  evaluation: CandidateEvaluation,
): Record<string, unknown> {
  const candidate = evaluation.candidate;
  const capabilities = {
    inferredFromDescription: evaluation.capabilities
      .filter((claim) => claim.basis === "inferred")
      .map((claim) => claim.name),
    registryDeclared: evaluation.capabilities
      .filter((claim) => claim.basis === "registry-declared")
      .map((claim) => claim.name),
    independentlyVerified: evaluation.capabilities
      .filter((claim) => claim.basis === "verified")
      .map((claim) => claim.name),
  };
  const securityWarnings: string[] = [];
  if (evaluation.securityRisk === "Unknown")
    securityWarnings.push("Security status is unknown from Registry metadata.");
  else if (evaluation.securityRisk === "Elevated concern")
    securityWarnings.push(
      "Review declared requirements; Registry screening is not a security audit.",
    );
  else if (evaluation.securityRisk === "Sensitive credential requirement")
    securityWarnings.push(
      "A sensitive credential is declared; scope and authentication are unverified.",
    );
  if (
    evaluation.securityFindings.some((finding) =>
      finding.includes("remote endpoint"),
    )
  )
    securityWarnings.push(
      "Uses a Registry-listed remote endpoint; operator and authentication are unverified.",
    );
  const installationSources = [
    ...candidate.operational.packages.flatMap((pkg) =>
      pkg.registryType || pkg.identifier
        ? [
            {
              type: "package",
              ...(pkg.registryType
                ? { registryType: safeTerminalText(pkg.registryType, 40) }
                : {}),
              ...(pkg.identifier
                ? { identifier: safeTerminalText(pkg.identifier, 120) }
                : {}),
              ...(pkg.version
                ? { version: safeTerminalText(pkg.version, 60) }
                : {}),
            },
          ]
        : [],
    ),
    ...Array.from(
      new Set(
        candidate.operational.remoteEndpoints.flatMap((endpoint) => {
          try {
            const parsed = new URL(endpoint);
            return parsed.protocol === "https:" ? [parsed.hostname] : [];
          } catch {
            return [];
          }
        }),
      ),
      (host) => ({ type: "remote_https", host }),
    ),
  ];
  return {
    registryIdentifier: safeTerminalText(candidate.registryIdentifier, 180),
    name: safeTerminalText(candidate.title ?? candidate.name, 120),
    ...(candidate.description
      ? { description: safeTerminalText(candidate.description, 160) }
      : {}),
    ...(candidate.version
      ? { version: safeTerminalText(candidate.version, 60) }
      : {}),
    registrySource: safeTerminalText(candidate.sourceRegistry, 80),
    installationSources,
    relevance: evaluation.relevance,
    confidence: evaluation.confidence,
    suitability: evaluation.suitability,
    capabilities,
    trust: evaluation.trust,
    security: {
      risk: evaluation.securityRisk,
      warnings: securityWarnings,
    },
  };
}
