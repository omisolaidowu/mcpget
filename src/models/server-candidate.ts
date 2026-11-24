export interface ServiceIdentity {
  hostname: string;
  domain: string;
  canonicalName: string;
  productName: string;
  productAliases: string[];
  domains: string[];
  registrySearchTerms: string[];
  isLocalOrIp: boolean;
}

export interface RegistryInputRequirement {
  name: string;
  required?: boolean;
  secret?: boolean;
  description?: string;
  deployment: "local-package" | "remote-endpoint";
}

export interface PackageReference {
  registryType?: string;
  identifier?: string;
  version?: string;
  runtimeHint?: string;
}

export interface OperationalMetadata {
  deploymentModels: Array<"Local package" | "Remote endpoint">;
  transports: string[];
  packages: PackageReference[];
  remoteEndpoints: string[];
  configurationInputs: RegistryInputRequirement[];
  authentication: "Unknown";
  clientCompatibility: "Unknown";
  setupComplexity: "Unknown";
}

export interface ServerCandidate {
  name: string;
  title?: string;
  description?: string;
  registryIdentifier: string;
  registryNamespace?: string;
  version?: string;
  registryStatus?: string;
  publishedAt?: string;
  updatedAt?: string;
  isLatest?: boolean;
  repositoryUrl?: string;
  websiteUrl?: string;
  operational: OperationalMetadata;
  sourceRegistry: string;
  sourceRecordUrl: string;
}
