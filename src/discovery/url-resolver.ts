import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { parse as parseDomain } from "tldts";
import type { ServiceIdentity } from "../models/server-candidate.js";

interface KnownProduct {
  name: string;
  canonicalDomain: string;
  aliases: string[];
  domains: string[];
  shorthand: string[];
}

const knownProducts: KnownProduct[] = [
  {
    name: "Notion",
    canonicalDomain: "notion.so",
    aliases: ["notion"],
    domains: ["notion.so", "notion.com"],
    shorthand: ["notion"],
  },
  {
    name: "GitHub",
    canonicalDomain: "github.com",
    aliases: ["github"],
    domains: ["github.com"],
    shorthand: ["github"],
  },
  {
    name: "Slack",
    canonicalDomain: "slack.com",
    aliases: ["slack"],
    domains: ["slack.com"],
    shorthand: ["slack"],
  },
  {
    name: "Linear",
    canonicalDomain: "linear.app",
    aliases: ["linear"],
    domains: ["linear.app"],
    shorthand: ["linear"],
  },
];

export class UrlResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlResolutionError";
  }
}

export function resolveServiceIdentity(input: string): ServiceIdentity {
  const value = input.trim();
  if (!value) {
    throw new UrlResolutionError("Enter a SaaS URL or domain to search.");
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) {
    throw new UrlResolutionError("Only http and https URLs are supported.");
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new UrlResolutionError(
      "The supplied value is not a valid URL or domain. Enter a hostname such as linear.app.",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UrlResolutionError("Only http and https URLs are supported.");
  }
  if (url.username || url.password) {
    throw new UrlResolutionError(
      "Do not include account credentials in the URL.",
    );
  }

  const hostname = domainToASCII(url.hostname.replace(/\.$/, "")).toLowerCase();
  if (!hostname) {
    throw new UrlResolutionError("The URL must contain a valid hostname.");
  }

  const parsed = parseDomain(hostname, { allowPrivateDomains: true });
  if (
    isIP(hostname) === 0 &&
    parsed.isIp !== true &&
    hostname !== "localhost" &&
    !hostname.endsWith(".localhost") &&
    !isValidDnsHostname(hostname)
  ) {
    throw new UrlResolutionError(
      "The URL must contain a valid DNS hostname or IP address.",
    );
  }
  const registrableDomain = parsed.domain ?? hostname;
  const knownProduct = knownProducts.find(
    (product) =>
      product.shorthand.includes(hostname) ||
      product.domains.includes(registrableDomain),
  );
  const domain = knownProduct?.canonicalDomain ?? registrableDomain;
  const isLocalOrIp =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isIP(hostname) !== 0 ||
    parsed.isIp === true;

  const productName =
    knownProduct?.aliases[0] ?? domain.split(".")[0]?.toLowerCase() ?? hostname;
  const productAliases = knownProduct?.aliases ?? [productName];
  const domains = knownProduct?.domains ?? [
    ...new Set([registrableDomain, hostname]),
  ];
  const isDomainHostname =
    hostname.includes(".") && isIP(hostname) === 0 && parsed.isIp !== true;
  const registrySearchTerms = isDomainHostname
    ? knownProduct
      ? [
          ...new Set(
            [knownProduct.aliases[0], ...knownProduct.shorthand].filter(
              (term): term is string => Boolean(term),
            ),
          ),
        ]
      : parsed.isIcann === true
        ? [
            parsed.domainWithoutSuffix ??
              registrableDomain.split(".")[0]?.toLowerCase() ??
              hostname.replace(/^www\./, ""),
          ].filter((term): term is string => Boolean(term))
        : [hostname.replace(/^www\./, "")]
    : [...new Set([productName, ...productAliases])];
  return {
    hostname,
    domain,
    canonicalName: knownProduct?.name ?? productName,
    productName,
    productAliases,
    domains,
    registrySearchTerms,
    isLocalOrIp,
  };
}

function isValidDnsHostname(hostname: string): boolean {
  if (hostname.length > 253) return false;
  return hostname
    .split(".")
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label),
    );
}
