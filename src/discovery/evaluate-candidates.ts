import type {
  CandidateEvaluation,
  CapabilityClaim,
  EvidenceItem,
  RecommendationReport,
  RelevanceClassification,
  TrustClassification,
  SecurityRisk,
} from "../models/candidate-evaluation.js";
import type { ServerCandidate, ServiceIdentity } from "../models/server-candidate.js";

const actions: Array<[string, RegExp]> = [
  ["Search", /\b(search|find|discover)\b/i],
  ["Read", /\b(read|retrieve|fetch|view|list)\b/i],
  ["Create", /\b(create|add|write|insert)\b/i],
  ["Update", /\b(update|edit|modify|change)\b/i],
  ["Delete", /\b(delete|remove|archive)\b/i],
];

const specializedPatterns = [
  /\b(url|identifier|issue id|id)\s+(shape|format|validation|validator)\b/i,
  /\b(validate|validate|check)\b.{0,30}\b(url|identifier|issue id|id)\b/i,
  /\b(large\s+)?file\s+upload|\bupload\s+(a\s+)?(large\s+)?files?\b/i,
  /\b(project\s+)?bootstrap|\bbootstrap\s+projects?\b/i,
];

const mathematicalLinearPatterns =
  /\blinear\s+(programming|algebra|regression|equation|optimization)\b|\b(simplex|objective function|constraint solver)\b/i;

const broadResources =
  /\b(workspaces?|pages?|databases?|blocks?|issues?|projects?|teams?|messages?|channels?|documents?|tasks?)\b/i;

export function evaluateCandidate(
  identity: ServiceIdentity,
  candidate: ServerCandidate,
): CandidateEvaluation {
  const evidence: EvidenceItem[] = [];
  const description = candidate.description ?? "";
  const leafName = candidate.name.split("/").at(-1) ?? candidate.name;
  const titleAndName = `${candidate.title ?? ""} ${leafName}`;
  const coreMetadata = [titleAndName, description].filter(Boolean).join("\n");
  const serviceMentionInName = containsProductName(titleAndName, identity.productAliases);
  const serviceMentionInDescription = containsProductName(description, identity.productAliases);
  const serviceMention = serviceMentionInName || serviceMentionInDescription;
  const domainMatch = findDomainMatch(identity, candidate);
  const namespaceOnlyMention = !serviceMention &&
    identity.productAliases.some((alias) =>
      (candidate.registryNamespace ?? "").toLowerCase().includes(alias.toLowerCase()),
    );
  const explicitFalsePositive =
    identity.productAliases.includes("linear") && mathematicalLinearPatterns.test(coreMetadata);
  const specialized = specializedPatterns.some((pattern) => pattern.test(coreMetadata));
  const capabilityEvidence = inferCapabilities(description);
  const hasBroadOperations =
    capabilityEvidence.length >= 2 && broadResources.test(description);
  const isGenericMcpEndpoint = Boolean(domainMatch) &&
    (candidate.name.toLowerCase().endsWith("/mcp") || /\bmcp server\b/i.test(description));

  let relevance: RelevanceClassification;
  if (explicitFalsePositive || namespaceOnlyMention || (!serviceMention && !domainMatch)) {
    relevance = "Unrelated / false positive";
  } else if (specialized) {
    relevance = "Specialized integration";
  } else if (hasBroadOperations || isGenericMcpEndpoint) {
    relevance = "Direct integration";
  } else if (serviceMention || domainMatch) {
    relevance = "Related integration";
  } else {
    relevance = "Unrelated / false positive";
  }

  if (domainMatch) {
    evidence.push({
      dimension: "relevance",
      type: "product-domain-reference",
      description: `Registry metadata references ${domainMatch}, a known domain for ${identity.canonicalName}.`,
      source: "Registry server description, website, repository, or endpoint metadata",
      strength: "high",
      basis: "inferred",
    });
  }
  if (serviceMentionInName) {
    evidence.push({
      dimension: "relevance",
      type: "product-name-reference",
      description: `${identity.canonicalName} appears in the server name or title.`,
      source: "Registry server name/title",
      strength: "medium",
      basis: "inferred",
    });
  }
  if (serviceMentionInDescription) {
    evidence.push({
      dimension: "relevance",
      type: "product-description-reference",
      description: `The publisher-provided description refers to ${identity.canonicalName}.`,
      source: "Registry server description",
      strength: "medium",
      basis: "inferred",
    });
  }
  if (namespaceOnlyMention) {
    evidence.push({
      dimension: "relevance",
      type: "namespace-only-keyword",
      description: `The product name appears only in registry namespace “${candidate.registryNamespace}”; the server name and description do not establish a service integration.`,
      source: "Registry identifier namespace",
      strength: "low",
      basis: "inferred",
    });
  }
  if (relevance === "Unrelated / false positive" && !namespaceOnlyMention && !explicitFalsePositive) {
    evidence.push({
      dimension: "relevance",
      type: "no-service-reference",
      description: "No product token or known product-domain reference appears in the server name, title, description, or available endpoint metadata.",
      source: "Registry server record",
      strength: "low",
      basis: "inferred",
    });
  }
  if (explicitFalsePositive) {
    evidence.push({
      dimension: "relevance",
      type: "ambiguous-product-word",
      description: "The metadata describes a mathematical linear-programming tool, not the Linear SaaS product.",
      source: "Registry server name/title/description",
      strength: "high",
      basis: "inferred",
    });
  }
  if (specialized) {
    evidence.push({
      dimension: "relevance",
      type: "narrow-purpose-signal",
      description: "The metadata describes a narrow task rather than a general-purpose service integration.",
      source: "Registry server name/title/description",
      strength: "high",
      basis: "inferred",
    });
  }
  if (hasBroadOperations) {
    evidence.push({
      dimension: "relevance",
      type: "broad-workflow-signal",
      description: "The description names multiple common operations over service data objects.",
      source: "Registry server description",
      strength: "medium",
      basis: "inferred",
    });
  }

  const contradictory = explicitFalsePositive || namespaceOnlyMention;
  const confidence = getConfidence({
    domainMatch,
    serviceMentionInName,
    serviceMentionInDescription,
    hasBroadOperations,
    contradictory,
    relevance,
  });
  evidence.push({
    dimension: "confidence",
    type: "metadata-association-confidence",
    description: confidenceDescription(confidence, domainMatch, serviceMention, contradictory),
    source: "Combined Registry metadata",
    strength: confidence.toLowerCase() as "high" | "medium" | "low",
    basis: "inferred",
  });

  const trustResult = classifyCandidateTrust(candidate);
  const trust = trustResult.classification;
  evidence.push(...trustResult.evidence);
  addOperationalEvidence(candidate, evidence);
  if (candidate.description && /\bofficial\b|\bvendor[- ]endorsed\b/i.test(candidate.description)) {
    evidence.push({
      dimension: "trust",
      type: "publisher-officialness-claim",
      description: "The publisher description claims official status; this claim has not been independently verified.",
      source: "Registry server description",
      strength: "low",
      basis: "observed",
    });
  }

  const suitabilityReasons: string[] = [];
  if (relevance === "Direct integration") suitabilityReasons.push("Classified as a general service integration");
  if (capabilityEvidence.length >= 3) suitabilityReasons.push("Description supports several distinct workflow capabilities");
  else if (capabilityEvidence.length >= 2) suitabilityReasons.push("Description supports multiple workflow capabilities");
  if (candidate.operational.remoteEndpoints.length > 0) suitabilityReasons.push("Registry lists a remote endpoint, which may reduce local setup steps; operator and authentication remain unverified");
  if (candidate.operational.packages.length > 0) suitabilityReasons.push("A local package is available for user-managed deployment");
  if (confidence === "Low") suitabilityReasons.push("Product association evidence is weak");
  const eligible = relevance === "Direct integration" &&
    (confidence === "High" || confidence === "Medium") && capabilityEvidence.length >= 2;
  const operationalFriction = getOperationalFriction(candidate);
  const security = assessCandidateSecurity(candidate);
  const evidenceQuality = getEvidenceQuality(candidate);
  const hostingAssessment = assessHosting(identity, candidate);
  const maintenanceSignals = [
    candidate.version ? `Registry version ${candidate.version}` : "",
    candidate.registryStatus ? `Registry status ${candidate.registryStatus}` : "",
    candidate.updatedAt ? `Registry update timestamp ${candidate.updatedAt}` : "",
    candidate.repositoryUrl ? "Repository reference available; maintenance activity not independently checked" : "",
  ].filter(Boolean);

  return {
    candidate,
    relevance,
    confidence,
    trust,
    capabilities: capabilityEvidence,
    evidence,
    recommendationEligible: eligible,
    suitability: !eligible ? "Insufficient evidence" : capabilityEvidence.length >= 3 && evidenceQuality >= 5 ? "Strong" : "Qualified",
    suitabilityReasons,
    operationalFriction,
    evidenceQuality: evidenceQuality >= 5 ? "Strong" : evidenceQuality >= 3 ? "Moderate" : "Limited",
    hostingAssessment,
    maintenanceSignals,
    securityRisk: security.risk,
    securityFindings: security.findings,
  };
}

export function evaluateCandidates(
  identity: ServiceIdentity,
  candidates: ServerCandidate[],
): RecommendationReport {
  const uniqueCandidates = uniqueByIdentifier(candidates);
  const evaluations = uniqueCandidates
    .map((candidate) => evaluateCandidate(identity, candidate))
    .sort((left, right) => compareSuitability(left, right) ||
      left.candidate.registryIdentifier.localeCompare(right.candidate.registryIdentifier));
  const withDuplicates = annotateDuplicates(evaluations);
  const recommended = withDuplicates
    .filter((item) => item.recommendationEligible)
    .sort((left, right) => compareSuitability(left, right) ||
      left.candidate.registryIdentifier.localeCompare(right.candidate.registryIdentifier))[0];

  const eligible = withDuplicates.filter((item) => item.recommendationEligible);
  const close = eligible.filter((item) => recommended && compareSuitability(recommended, item) === 0);
  const recommendationStatus = !recommended
    ? "none"
    : close.length > 1
      ? "similar candidates"
      : recommended.suitability === "Strong" && recommended.confidence === "High" && recommended.evidenceQuality === "Strong"
        ? "confident"
        : "qualified";
  return {
    service: identity,
    candidateCount: uniqueCandidates.length,
    ...(recommended && recommendationStatus !== "similar candidates"
      ? { recommendedCandidateId: recommended.candidate.registryIdentifier }
      : {}),
    recommendationStatus,
    recommendationReasons: getRecommendationReasons(recommended, withDuplicates),
    alternativeCandidateIds: selectAlternatives(withDuplicates, recommended, recommendationStatus, close),
    recommendationMessage: !recommended
      ? "No confident recommendation. Candidate metadata does not establish a general-purpose integration with sufficient capabilities."
      : recommendationStatus === "similar candidates"
        ? "Several candidates appear similarly suitable; available Registry evidence does not establish a clear winner."
        : recommendationStatus === "confident"
          ? "Confident recommendation based on broad described functionality and corroborating product evidence."
          : "Qualified recommendation based on the available metadata; review the listed unknowns and alternatives.",
    evaluations: withDuplicates,
  };
}

function getRecommendationReasons(
  recommended: CandidateEvaluation | undefined,
  evaluations: CandidateEvaluation[],
): string[] {
  if (!recommended || !recommended.recommendationEligible) return [];
  const direct = evaluations.filter((item) => item !== recommended && item.relevance === "Direct integration");
  const recommendedIsRemote = recommended.candidate.operational.deploymentModels.includes("Remote endpoint");
  const domainHostedAlternative = !recommended.hostingAssessment.startsWith("Remote endpoint on a known service domain")
    ? direct.find((item) =>
      item.hostingAssessment.startsWith("Remote endpoint on a known service domain"))
    : undefined;
  const alternative = domainHostedAlternative ?? direct.find((item) =>
    item.candidate.operational.deploymentModels.includes("Remote endpoint") !== recommendedIsRemote) ??
    direct[0];
  const reasons: string[] = [];
  if (alternative && recommended.capabilities.length > alternative.capabilities.length) {
    reasons.push(`More distinct described capabilities than ${alternative.candidate.title ?? alternative.candidate.name}`);
  }
  if (recommended.confidence === "High") reasons.push("Product association has corroborating Registry evidence");
  if (alternative && recommended.evidenceQuality === "Strong" && alternative.evidenceQuality !== "Strong") {
    reasons.push("More complete Registry metadata than the closest direct alternative");
  }
  if (alternative && recommended.operationalFriction === "Low" && alternative.operationalFriction !== "Low") {
    reasons.push("Fewer declared setup requirements than the closest direct alternative");
  }
  if (recommended.hostingAssessment.startsWith("Remote endpoint on a known service domain")) {
    reasons.push("Remote endpoint appears on a known service domain; operator and authentication are unverified");
  }
  reasons.push(...recommended.suitabilityReasons.filter((reason) => reason.startsWith("Classified")));
  return [...new Set(reasons)].slice(0, 3);
}

function selectAlternatives(
  evaluations: CandidateEvaluation[],
  recommended: CandidateEvaluation | undefined,
  status: RecommendationReport["recommendationStatus"],
  tied: CandidateEvaluation[],
): string[] {
  if (status === "similar candidates") return tied.slice(0, 2).map((item) => item.candidate.registryIdentifier);
  const candidates = evaluations.filter((item) => item !== recommended && item.relevance === "Direct integration");
  const selected = candidates.slice(0, 1);
  const hasRemote = (item: CandidateEvaluation): boolean => item.candidate.operational.deploymentModels.includes("Remote endpoint");
  const recommendedHasRemote = recommended ? hasRemote(recommended) : undefined;
  if (selected.length < 2 && recommended &&
      !recommended.hostingAssessment.startsWith("Remote endpoint on a known service domain")) {
    const domainHosted = candidates.find((item) =>
      !selected.includes(item) && item.hostingAssessment.startsWith("Remote endpoint on a known service domain") &&
      !(recommended.duplicate && item.duplicate?.groupId === recommended.duplicate.groupId),
    );
    if (domainHosted) selected.push(domainHosted);
  }
  if (selected.length < 2 && recommendedHasRemote !== undefined) {
    const differentDeployment = candidates.find((item) =>
      !selected.includes(item) && hasRemote(item) !== recommendedHasRemote &&
      !(recommended?.duplicate && item.duplicate?.groupId === recommended.duplicate.groupId),
    );
    if (differentDeployment) selected.push(differentDeployment);
  }
  for (const candidate of candidates) {
    if (selected.length >= 2) break;
    if (selected.includes(candidate)) continue;
    if (recommended?.duplicate && candidate.duplicate?.groupId === recommended.duplicate.groupId) continue;
    if (selected.some((item) => item.duplicate && item.duplicate.groupId === candidate.duplicate?.groupId)) continue;
    selected.push(candidate);
  }
  return selected.map((item) => item.candidate.registryIdentifier);
}

function uniqueByIdentifier(candidates: ServerCandidate[]): ServerCandidate[] {
  const records = new Map<string, ServerCandidate>();
  for (const candidate of candidates) {
    const previous = records.get(candidate.registryIdentifier);
    if (!previous || metadataCompleteness(candidate) > metadataCompleteness(previous)) {
      records.set(candidate.registryIdentifier, candidate);
    }
  }
  return [...records.values()];
}

function metadataCompleteness(candidate: ServerCandidate): number {
  return Number(Boolean(candidate.title)) + Number(Boolean(candidate.description)) +
    Number(Boolean(candidate.version)) + Number(Boolean(candidate.repositoryUrl)) +
    Number(Boolean(candidate.websiteUrl)) + candidate.operational.packages.length +
    candidate.operational.remoteEndpoints.length + candidate.operational.configurationInputs.length;
}

function getEvidenceQuality(candidate: ServerCandidate): number {
  return Number(Boolean(candidate.description)) +
    Number(Boolean(candidate.repositoryUrl || candidate.websiteUrl)) +
    Number(Boolean(candidate.version)) +
    Number(Boolean(candidate.registryStatus || candidate.publishedAt || candidate.updatedAt)) +
    Number(candidate.operational.deploymentModels.length > 0 || candidate.operational.packages.length > 0 ||
      candidate.operational.remoteEndpoints.length > 0 || candidate.operational.configurationInputs.length > 0);
}

function getOperationalFriction(candidate: ServerCandidate): CandidateEvaluation["operationalFriction"] {
  const op = candidate.operational;
  if (!op.deploymentModels.length) return "Unknown";
  const secretCount = op.configurationInputs.filter((input) => input.secret).length;
  if (op.deploymentModels.includes("Remote endpoint") && op.remoteEndpoints.length && !op.packages.length && !secretCount) return "Medium";
  if (secretCount >= 2 || op.configurationInputs.length >= 4) return "High";
  if (op.deploymentModels.includes("Local package") || secretCount > 0 || op.configurationInputs.length > 0) return "Medium";
  return "Unknown";
}

function assessHosting(identity: ServiceIdentity, candidate: ServerCandidate): string {
  if (!candidate.operational.remoteEndpoints.length) return candidate.operational.packages.length ? "Local package; hosting not applicable" : "Hosting unknown";
  const serviceDomainEndpoint = candidate.operational.remoteEndpoints.some((endpoint) =>
    identity.domains.some((domain) => urlHostMatches(endpoint, domain)),
  );
  return serviceDomainEndpoint
    ? "Remote endpoint on a known service domain; hosting operator is not independently verified"
    : "Remote third-party endpoint; operator is not independently verified";
}

export function assessCandidateSecurity(candidate: ServerCandidate): { risk: SecurityRisk; findings: string[] } {
  const inputs = candidate.operational.configurationInputs;
  const findings: string[] = [];
  let risk: SecurityRisk = "Unknown";
  for (const input of inputs) {
    const descriptor = `${input.name} ${input.description ?? ""}`;
    if (/token_v2|session\s*cookie|browser\s+cookie|auth(?:entication)?\s*cookie/i.test(descriptor)) {
      risk = "Elevated concern";
      findings.push("Requests a browser-session credential; this is more sensitive than a scoped integration token.");
    } else if (/filesystem|file\s*system|directory|folder|path|docker|socket/i.test(descriptor)) {
      if (risk !== "Elevated concern") risk = "Elevated concern";
      findings.push(`Requests local resource access via ${input.name}; review the stated scope before use.`);
    } else if (input.secret === true || /api[_ -]?key|access[_ -]?token|personal[_ -]?access[_ -]?token|oauth|credential/i.test(descriptor)) {
      if (risk !== "Elevated concern") risk = "Sensitive credential requirement";
      findings.push(`Requires sensitive credential input ${input.name}; protocol and scope may be unknown.`);
    } else if (/workspace[_ -]?id|user[_ -]?id/i.test(descriptor)) {
      if (risk === "Unknown") risk = "Informational";
      findings.push(`Requests user or workspace identifier ${input.name}; the permitted scope is unknown.`);
    }
  }
  if (candidate.operational.remoteEndpoints.length) {
    findings.push("Uses a Registry-listed remote endpoint; requests depend on that external service.");
  }
  if (!findings.length && inputs.length === 0 && candidate.operational.remoteEndpoints.length === 0) findings.push("Security requirements are unknown from available Registry metadata.");
  return { risk, findings: [...new Set(findings)] };
}

function annotateDuplicates(evaluations: CandidateEvaluation[]): CandidateEvaluation[] {
  const edges: Array<{ left: number; right: number; reasons: string[]; strong: boolean; versionNote?: string }> = [];
  const parents = evaluations.map((_, index) => index);
  const find = (index: number): number => parents[index] === index ? index : (parents[index] = find(parents[index]!));
  const join = (left: number, right: number): void => { parents[find(right)] = find(left); };
  for (let i = 0; i < evaluations.length; i += 1) {
    for (let j = i + 1; j < evaluations.length; j += 1) {
      const left = evaluations[i]!.candidate;
      const right = evaluations[j]!.candidate;
      const sameRepo = normalizeRepository(left.repositoryUrl) && normalizeRepository(left.repositoryUrl) === normalizeRepository(right.repositoryUrl);
      const leftPackages = new Set(left.operational.packages.map((pkg) => pkg.identifier?.toLowerCase()).filter(Boolean));
      const samePackage = right.operational.packages.some((pkg) => pkg.identifier && leftPackages.has(pkg.identifier.toLowerCase()));
      const reasons = [sameRepo ? "same normalized repository" : "", samePackage ? "same package identifier" : ""].filter(Boolean);
      if (!reasons.length || (!sameRepo && !samePackage)) continue;
      const versionNote = compareVersionPair(left.version, right.version);
      edges.push({ left: i, right: j, reasons, strong: Boolean(sameRepo && samePackage), ...(versionNote ? { versionNote } : {}) });
      join(i, j);
    }
  }
  const components = new Map<number, number[]>();
  for (let i = 0; i < evaluations.length; i += 1) {
    const root = find(i);
    components.set(root, [...(components.get(root) ?? []), i]);
  }
  const relationships = new Map<number, NonNullable<CandidateEvaluation["duplicate"]>>();
  for (const component of components.values()) {
    if (component.length < 2) continue;
    const identifiers = component.map((index) => evaluations[index]!.candidate.registryIdentifier).sort();
    const componentEdges = edges.filter((edge) => component.includes(edge.left) && component.includes(edge.right));
    const reasons = [...new Set(componentEdges.flatMap((edge) => edge.reasons))];
    const versionNotes = [...new Set(componentEdges.flatMap((edge) => edge.versionNote ? [edge.versionNote] : []))];
    const completeStrongEvidence = componentEdges.length === component.length * (component.length - 1) / 2 && componentEdges.every((edge) => edge.strong);
    for (const index of component) {
      relationships.set(index, {
        groupId: `duplicate:${identifiers.join("+")}`,
        confidence: completeStrongEvidence ? "Likely same project" : "Possible duplicate",
        relatedIdentifiers: identifiers.filter((identifier) => identifier !== evaluations[index]!.candidate.registryIdentifier),
        reasons,
        ...(versionNotes.length ? { versionNote: versionNotes.join(" ") } : {}),
      });
    }
  }
  return evaluations.map((item) => {
    const duplicate = relationships.get(evaluations.indexOf(item));
    return { ...item, ...(duplicate ? { duplicate } : {}) };
  });
}

function compareVersionPair(left?: string, right?: string): string | undefined {
  const parse = (value?: string): { core: number[]; pre: string } | undefined => {
    const match = value?.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
    return match ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? "" } : undefined;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b || !left || !right || left === right) return undefined;
  let comparison = 0;
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) { comparison = a.core[i]! > b.core[i]! ? 1 : -1; break; }
  }
  if (!comparison && a.pre !== b.pre) comparison = !a.pre ? 1 : !b.pre ? -1 : a.pre.localeCompare(b.pre);
  return comparison > 0 ? `Version comparison: ${left} appears newer than ${right}.` :
    comparison < 0 ? `Version comparison: ${right} appears newer than ${left}.` : undefined;
}

function normalizeRepository(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch { return undefined; }
}

function getConfidence(input: {
  domainMatch: string | undefined;
  serviceMentionInName: boolean;
  serviceMentionInDescription: boolean;
  hasBroadOperations: boolean;
  contradictory: boolean;
  relevance: RelevanceClassification;
}): "High" | "Medium" | "Low" {
  if (input.relevance === "Unrelated / false positive" || input.contradictory) return "Low";
  if (input.domainMatch && (input.serviceMentionInName || input.serviceMentionInDescription)) {
    return "High";
  }
  if (input.serviceMentionInName && input.serviceMentionInDescription && input.hasBroadOperations) {
    return "Medium";
  }
  if (input.domainMatch || input.serviceMentionInName || input.serviceMentionInDescription) {
    return "Medium";
  }
  return "Low";
}

function confidenceDescription(
  confidence: string,
  domainMatch: string | undefined,
  serviceMention: boolean,
  contradictory: boolean,
): string {
  if (contradictory) return "Conflicting or namespace-only evidence lowers confidence.";
  if (confidence === "High") return "An exact product-domain reference is corroborated by a product mention.";
  if (confidence === "Medium") {
    return domainMatch
      ? "A product-domain reference is present, but independent corroboration is limited."
      : "Product-name evidence is present, but no independently verified product-domain link is available.";
  }
  return serviceMention
    ? "Only a limited product-name signal is available."
    : "Available metadata does not establish a meaningful association with the target service.";
}

export function classifyCandidateTrust(candidate: ServerCandidate): {
  classification: TrustClassification;
  evidence: EvidenceItem[];
} {
  const evidence: EvidenceItem[] = [];
  if (candidate.registryNamespace) {
    evidence.push({
      dimension: "trust",
      type: "registry-namespace",
      description: `Registry namespace “${candidate.registryNamespace}” is observed, but it does not independently identify or verify the maintainer.`,
      source: "Registry server identifier",
      strength: "low",
      basis: "observed",
    });
  }
  if (candidate.repositoryUrl) {
    evidence.push({
      dimension: "trust",
      type: "repository-reference",
      description: "A repository URL is present, but repository ownership and publisher identity have not been verified.",
      source: "Registry repository field",
      strength: "low",
      basis: "observed",
    });
    evidence.push({
      dimension: "trust",
      type: "publisher-identity-gap",
      description: "Registry search metadata does not independently establish who maintains this server or whether they are affiliated with the vendor.",
      source: "Official MCP Registry response",
      strength: "insufficient",
      basis: "observed",
    });
    return { classification: "Unverified", evidence };
  }

  evidence.push({
    dimension: "trust",
    type: "publisher-identity-missing",
    description: "No repository or independent publisher-verification evidence is available in the Registry response.",
    source: "Official MCP Registry response",
    strength: "insufficient",
    basis: "observed",
  });
  return { classification: "Insufficient evidence", evidence };
}

function addOperationalEvidence(candidate: ServerCandidate, evidence: EvidenceItem[]): void {
  const { operational } = candidate;
  if (
    operational.deploymentModels.length > 0 ||
    operational.transports.length > 0 ||
    operational.packages.length > 0 ||
    operational.remoteEndpoints.length > 0 ||
    operational.configurationInputs.length > 0
  ) {
    evidence.push({
      dimension: "operational",
      type: "registry-operational-metadata",
      description: "Deployment, transport, package, endpoint, and configuration-input details shown were present in Registry metadata.",
      source: "Registry packages/remotes fields",
      strength: "medium",
      basis: "observed",
    });
  } else {
    evidence.push({
      dimension: "operational",
      type: "operational-metadata-missing",
      description: "Deployment model, transport, authentication, and client compatibility are unknown from the available record.",
      source: "Registry response",
      strength: "insufficient",
      basis: "observed",
    });
  }
  if (operational.configurationInputs.some((input) => input.secret === true)) {
    evidence.push({
      dimension: "operational",
      type: "secret-configuration-input",
      description: "Registry metadata declares a secret configuration input; this does not identify the authentication protocol.",
      source: "Registry package/remote input metadata",
      strength: "medium",
      basis: "observed",
    });
  }
}

export function inferCapabilities(description: string): CapabilityClaim[] {
  const capabilities: CapabilityClaim[] = [];
  for (const [name, pattern] of actions) {
    if (pattern.test(description)) {
      capabilities.push({ name, source: "registry description", basis: "inferred" });
    }
  }
  if (/\b(database|databases|database queries)\b/i.test(description)) {
    capabilities.push({ name: "Database queries", source: "registry description", basis: "inferred" });
  }
  if (/\b(file|files|upload|download)\b/i.test(description)) {
    capabilities.push({ name: "File operations", source: "registry description", basis: "inferred" });
  }
  if (/\b(issues?|projects?|cycles?|roadmaps?)\b/i.test(description)) {
    capabilities.push({ name: "Project and issue workflows", source: "registry description", basis: "inferred" });
  }
  if (/\b(pages?|blocks?|workspaces?)\b/i.test(description)) {
    capabilities.push({ name: "Page and workspace content", source: "registry description", basis: "inferred" });
  }
  return [...new Map(capabilities.map((claim) => [claim.name, claim])).values()];
}

function findDomainMatch(identity: ServiceIdentity, candidate: ServerCandidate): string | undefined {
  const textFields = [candidate.name.split("/").at(-1), candidate.title, candidate.description]
    .filter((value): value is string => Boolean(value));
  const urlFields = [
    candidate.repositoryUrl,
    candidate.websiteUrl,
    ...candidate.operational.remoteEndpoints,
  ].filter((value): value is string => Boolean(value));
  for (const domain of identity.domains) {
    const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const textPattern = new RegExp(`(^|[^a-z0-9-])(?:[a-z0-9-]+\\.)*${escaped}(?=$|[^a-z0-9.-])`, "i");
    const metadataHasDomain = textFields.some((value) => {
      const urls = value.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
      if (urls.some((url) => urlHostMatches(url, domain))) return true;
      return textPattern.test(value.replace(/https?:\/\/[^\s"'<>]+/gi, " "));
    });
    if (metadataHasDomain || urlFields.some((value) => urlHostMatches(value, domain))) {
      return domain;
    }
  }
  return undefined;
}

function urlHostMatches(value: string, domain: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
    return hostname === domain || hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function containsProductName(text: string, aliases: string[]): boolean {
  return aliases.some((alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(text);
  });
}

function relevanceRank(value: RelevanceClassification): number {
  switch (value) {
    case "Direct integration": return 0;
    case "Specialized integration": return 1;
    case "Related integration": return 2;
    case "Unrelated / false positive": return 3;
  }
}

// Lexicographic comparison keeps the dimensions visible and avoids an opaque composite score.
function compareSuitability(left: CandidateEvaluation, right: CandidateEvaluation): number {
  const compareHigh = (a: number, b: number): number => b - a;
  const compareLow = (a: number, b: number): number => a - b;
  const confidence = (value: CandidateEvaluation["confidence"]): number => value === "High" ? 2 : value === "Medium" ? 1 : 0;
  const evidence = (value: CandidateEvaluation["evidenceQuality"]): number => value === "Strong" ? 2 : value === "Moderate" ? 1 : 0;
  const friction = (value: CandidateEvaluation["operationalFriction"]): number => value === "Low" ? 0 : value === "Medium" ? 1 : value === "Unknown" ? 2 : 3;
  const risk = (value: CandidateEvaluation["securityRisk"]): number => value === "Informational" ? 0 : value === "Unknown" ? 1 : value === "Sensitive credential requirement" ? 2 : 3;
  const maintenance = (candidate: ServerCandidate): number => {
    const status = candidate.registryStatus?.toLowerCase();
    return (status === "active" ? 2 : status === "deprecated" || status === "archived" || status === "inactive" ? -2 : 0) +
      (candidate.isLatest === true ? 1 : candidate.isLatest === false ? -1 : 0);
  };
  const hosting = (value: string): number => value.startsWith("Remote endpoint on a known service domain") ? 1 : 0;
  return compareLow(relevanceRank(left.relevance), relevanceRank(right.relevance)) ||
    compareHigh(left.capabilities.length, right.capabilities.length) ||
    compareHigh(confidence(left.confidence), confidence(right.confidence)) ||
    compareHigh(evidence(left.evidenceQuality), evidence(right.evidenceQuality)) ||
    compareLow(friction(left.operationalFriction), friction(right.operationalFriction)) ||
    compareLow(risk(left.securityRisk), risk(right.securityRisk)) ||
    compareHigh(maintenance(left.candidate), maintenance(right.candidate)) ||
    compareHigh(hosting(left.hostingAssessment), hosting(right.hostingAssessment));
}
