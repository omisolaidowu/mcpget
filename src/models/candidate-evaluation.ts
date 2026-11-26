import type { ServerCandidate, ServiceIdentity } from "./server-candidate.js";

export type RelevanceClassification =
  | "Direct integration"
  | "Specialized integration"
  | "Related integration"
  | "Unrelated / false positive";

export type MatchConfidence = "High" | "Medium" | "Low";

export type TrustClassification =
  | "Vendor verified"
  | "Publisher verified"
  | "Community maintained"
  | "Unverified"
  | "Insufficient evidence";

export interface EvidenceItem {
  dimension: "relevance" | "confidence" | "trust" | "operational";
  type: string;
  description: string;
  source: string;
  strength: "high" | "medium" | "low" | "insufficient";
  basis: "observed" | "inferred";
}

export interface CapabilityClaim {
  name: string;
  source: "registry description";
  basis: "inferred" | "registry-declared" | "verified";
}

export type SecurityRisk =
  | "Informational"
  | "Sensitive credential requirement"
  | "Elevated concern"
  | "Unknown";

export interface DuplicateRelationship {
  groupId: string;
  confidence: "Likely same project" | "Possible duplicate";
  relatedIdentifiers: string[];
  reasons: string[];
  versionNote?: string;
}

export interface CandidateEvaluation {
  candidate: ServerCandidate;
  relevance: RelevanceClassification;
  confidence: MatchConfidence;
  trust: TrustClassification;
  capabilities: CapabilityClaim[];
  evidence: EvidenceItem[];
  recommendationEligible: boolean;
  suitability: "Strong" | "Qualified" | "Insufficient evidence";
  suitabilityReasons: string[];
  operationalFriction: "Low" | "Medium" | "High" | "Unknown";
  evidenceQuality: "Strong" | "Moderate" | "Limited";
  hostingAssessment: string;
  maintenanceSignals: string[];
  securityRisk: SecurityRisk;
  securityFindings: string[];
  duplicate?: DuplicateRelationship;
}

export interface RecommendationReport {
  service: ServiceIdentity;
  candidateCount: number;
  topCandidateId?: string;
  recommendationMessage: string;
  recommendationStatus:
    "recommended" | "candidate" | "similar_candidates" | "no_recommendation";
  recommendationReasons: string[];
  alternativeCandidateIds: string[];
  evaluations: CandidateEvaluation[];
}
