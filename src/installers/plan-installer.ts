import type { ServerCandidate } from "../models/server-candidate.js";
import type { InstallPlan, ServerConfiguration } from "./types.js";
import { dirname, join } from "node:path";
import { parsePublicHttpsEndpoint } from "../security/remote-endpoint.js";

function safeName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "mcp-server"
  );
}

export function createInstallPlan(
  candidate: ServerCandidate,
  forcedName?: string,
  selectedSource?: string,
  ephemeral = false,
  allowLifecycleScripts = false,
): InstallPlan {
  const name = safeName(forcedName ?? candidate.title ?? candidate.name);
  const remotes = candidate.operational.remoteEndpoints.filter((endpoint) => {
    try {
      parsePublicHttpsEndpoint(endpoint);
      return true;
    } catch {
      return false;
    }
  });
  const validPackages = candidate.operational.packages.filter(
    (item) => item.identifier && item.registryType,
  );
  const sources = [
    ...(remotes.length ? ["remote"] : []),
    ...validPackages.map(
      (item) => `${item.registryType!.toLowerCase()}:${item.identifier}`,
    ),
  ];
  if (selectedSource && !sources.includes(selectedSource))
    throw new Error("The selected installation source is no longer available.");
  if (!selectedSource && sources.length > 1)
    throw new Error(
      `This server has multiple installation sources (${sources.join(", ")}). Choose one explicitly.`,
    );
  if (selectedSource === "remote" || (!selectedSource && remotes.length)) {
    const transport = candidate.operational.transports[0];
    const entry: ServerConfiguration = {
      name,
      url: remotes[0]!,
      ...(transport ? { transport } : {}),
    };
    return {
      candidate,
      entry,
      requiresExecutionConsent: false,
      method: "HTTPS remote MCP endpoint",
      strategy: "remote",
    };
  }
  const pkg = validPackages.find(
    (item) =>
      !selectedSource ||
      `${item.registryType!.toLowerCase()}:${item.identifier}` ===
        selectedSource,
  );
  if (!pkg)
    throw new Error(
      "This Registry entry has no supported package or HTTPS remote endpoint. Inspect it or choose a different server.",
    );
  const registryType = pkg.registryType!.toLowerCase();
  if (
    registryType === "npm" &&
    (!/^(?:@[a-z0-9._~-]+\/)?[a-z0-9][a-z0-9._~-]*$/i.test(pkg.identifier!) ||
      pkg.identifier!.startsWith("-") ||
      pkg.identifier!.startsWith("."))
  )
    throw new Error(
      "The Registry contains an unsupported npm package identifier.",
    );
  if (
    registryType === "pypi" &&
    (!/^[a-z0-9][a-z0-9._-]*$/i.test(pkg.identifier!) ||
      pkg.identifier!.startsWith("-") ||
      pkg.identifier!.startsWith("."))
  )
    throw new Error(
      "The Registry contains an unsupported Python package identifier.",
    );
  if (
    registryType === "oci" &&
    (!/^[a-z0-9][a-z0-9._/:@-]*$/i.test(pkg.identifier!) ||
      pkg.identifier!.startsWith("-") ||
      pkg.identifier!.startsWith("."))
  )
    throw new Error(
      "The Registry contains an unsupported OCI image identifier.",
    );
  if (pkg.version && !/^[a-z0-9][a-z0-9.+_-]*$/i.test(pkg.version))
    throw new Error(
      "The Registry contains an unsupported package version identifier.",
    );
  if (registryType !== "npm" && !ephemeral)
    throw new Error(
      `Persistent managed installation is currently supported for npm packages only. Retry with --ephemeral to explicitly use the existing ${registryType} execution strategy.`,
    );
  let command: string;
  let args: string[];
  if (registryType === "npm") {
    if (!ephemeral) {
      command = process.execPath;
      args = [];
    } else if (process.platform === "win32") {
      command = process.execPath;
      args = [
        join(
          dirname(process.execPath),
          "node_modules",
          "npm",
          "bin",
          "npx-cli.js",
        ),
        "-y",
        ...(!allowLifecycleScripts ? ["--ignore-scripts"] : []),
        "--",
        `${pkg.identifier}${pkg.version ? `@${pkg.version}` : ""}`,
      ];
    } else {
      command = "npx";
      args = [
        "-y",
        ...(!allowLifecycleScripts ? ["--ignore-scripts"] : []),
        "--",
        `${pkg.identifier}${pkg.version ? `@${pkg.version}` : ""}`,
      ];
    }
  } else if (registryType === "pypi") {
    command = "uvx";
    args = pkg.version
      ? ["--from", `${pkg.identifier}==${pkg.version}`, pkg.identifier!]
      : [pkg.identifier!];
  } else if (registryType === "oci") {
    command = "docker";
    args = ["run", "--rm", "-i", pkg.identifier!];
  } else
    throw new Error(
      `Registry package type “${registryType}” is not supported yet.`,
    );
  const entry: ServerConfiguration = { name, command, args };
  if (pkg.registryType!.toLowerCase() === "oci")
    entry.args = ["run", "--rm", "-i", pkg.identifier!];
  return {
    candidate,
    entry,
    requiresExecutionConsent: true,
    method: `${registryType} package ${pkg.identifier}`,
    packageIdentifier: pkg.identifier!,
    ...(pkg.version ? { packageVersion: pkg.version } : {}),
    packageType: registryType,
    strategy: registryType === "npm" && !ephemeral ? "managed" : "ephemeral",
  };
}
