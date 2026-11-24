import type { RecommendationReport } from "../models/candidate-evaluation.js";
import type { ServerCandidate } from "../models/server-candidate.js";
import { evaluateCandidates } from "./evaluate-candidates.js";
import { OfficialRegistryAdapter } from "./registry/official-registry-adapter.js";
import { resolveServiceIdentity } from "./url-resolver.js";

export interface CandidateSource {
  searchByName(name: string): Promise<ServerCandidate[]>;
  getByIdentifier?(identifier: string): Promise<ServerCandidate>;
}

export type DiscoveryResult = RecommendationReport;

export async function discoverByServiceUrl(
  input: string,
  source: CandidateSource = new OfficialRegistryAdapter(),
): Promise<DiscoveryResult> {
  const identity = resolveServiceIdentity(input);
  if (identity.isLocalOrIp) {
    throw new Error("Registry discovery requires a public service domain, not localhost or an IP address.");
  }
  const candidatesById = new Map<string, ServerCandidate>();
  for (const term of identity.registrySearchTerms) {
    for (const candidate of await source.searchByName(term)) {
      candidatesById.set(candidate.registryIdentifier, candidate);
    }
  }
  return evaluateCandidates(identity, [...candidatesById.values()]);
}
