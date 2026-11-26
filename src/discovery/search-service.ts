import type { RecommendationReport } from "../models/candidate-evaluation.js";
import type { ServerCandidate } from "../models/server-candidate.js";
import { evaluateCandidates } from "./evaluate-candidates.js";
import {
  OfficialRegistryAdapter,
  type RegistrySearchResult,
} from "./registry/official-registry-adapter.js";
import { resolveServiceIdentity } from "./url-resolver.js";

export interface CandidateSource {
  searchByName(name: string): Promise<ServerCandidate[]>;
  searchByNameWithMetadata?(name: string): Promise<RegistrySearchResult>;
  getByIdentifier?(identifier: string): Promise<ServerCandidate>;
}

export type DiscoveryMetadata = Omit<RegistrySearchResult, "candidates">;
export type DiscoveryResult = RecommendationReport & {
  discovery: DiscoveryMetadata;
};

const completedWithoutPageMetadata: DiscoveryMetadata = {
  status: "complete",
  terminationReason: "cursor_exhausted",
  pagesFetched: 0,
  safetyLimitReached: false,
};

export async function discoverByServiceUrl(
  input: string,
  source: CandidateSource = new OfficialRegistryAdapter(),
): Promise<DiscoveryResult> {
  const identity = resolveServiceIdentity(input);
  if (identity.isLocalOrIp) {
    throw new Error(
      "Registry discovery requires a public service domain, not localhost or an IP address.",
    );
  }
  const candidatesById = new Map<string, ServerCandidate>();
  let pagesFetched = 0;
  let partial = false;
  let safetyLimitReached = false;
  for (const term of identity.registrySearchTerms) {
    const searchResult = source.searchByNameWithMetadata
      ? await source.searchByNameWithMetadata(term)
      : {
          ...completedWithoutPageMetadata,
          candidates: await source.searchByName(term),
        };
    pagesFetched += searchResult.pagesFetched;
    partial ||= searchResult.status === "partial";
    safetyLimitReached ||= searchResult.safetyLimitReached;
    for (const candidate of searchResult.candidates) {
      candidatesById.set(candidate.registryIdentifier, candidate);
    }
  }
  return {
    ...evaluateCandidates(identity, [...candidatesById.values()]),
    discovery: {
      status: partial ? "partial" : "complete",
      terminationReason: partial ? "page_limit_reached" : "cursor_exhausted",
      pagesFetched,
      safetyLimitReached,
    },
  };
}
