import type { ClientId, ConfigurationScope } from "../installers/types.js";

export type InstallationStepStatus =
  | "completed"
  | "not_applicable"
  | "not_verified"
  | "authentication_required"
  | "setup_required"
  | "failed";
export interface InstallationStep {
  status: InstallationStepStatus;
  detail: string;
  at?: string;
}
export interface InstallationRecord {
  id: string;
  serverIdentifier: string;
  displayName: string;
  client: ClientId;
  source: string;
  strategy: "managed" | "ephemeral" | "remote";
  installationPath?: string;
  packageIdentifier?: string;
  installedVersion?: string;
  lifecycleScriptsEnabled?: boolean;
  remoteEndpoint?: string;
  remoteEndpointTrust?: "pending" | "public_https" | "rejected";
  configName: string;
  configPath: string;
  configScope?: ConfigurationScope;
  projectRoot?: string;
  createdAt: string;
  states: {
    resolved: InstallationStep;
    install_confirmed: InstallationStep;
    installed: InstallationStep;
    execution_registered: InstallationStep;
    configured: InstallationStep;
    setup_required: InstallationStep;
    authenticated: InstallationStep;
    startup_verified: InstallationStep;
    connection_verified: InstallationStep;
    client_connection_verified: InstallationStep;
  };
  lastError?: string;
}

export function pendingStep(detail = "Not checked."): InstallationStep {
  return { status: "not_verified", detail };
}

export function createInstallationRecord(
  input: Omit<InstallationRecord, "states" | "createdAt">,
): InstallationRecord {
  const now = new Date().toISOString();
  const nA = (detail: string): InstallationStep => ({
    status: "not_applicable",
    detail,
  });
  return {
    ...input,
    createdAt: now,
    states: {
      resolved: {
        status: "completed",
        detail: "Server source and client target resolved.",
        at: now,
      },
      install_confirmed: pendingStep("Awaiting user approval."),
      installed:
        input.strategy === "remote"
          ? nA("Remote server; no local package installation applies.")
          : input.strategy === "ephemeral"
            ? nA(
                "Ephemeral runtime registration; this is not a persistent package installation.",
              )
            : pendingStep("Managed package has not been installed."),
      execution_registered:
        input.strategy === "remote"
          ? nA("Remote endpoint; no local execution command applies.")
          : input.strategy === "managed"
            ? nA(
                "The managed package is configured directly from its installation directory.",
              )
            : pendingStep("Execution command has not been verified."),
      configured: pendingStep("Client configuration has not been changed."),
      setup_required: pendingStep(
        "Authentication and setup requirements have not been identified.",
      ),
      authenticated: pendingStep(
        "Authentication requirements are unknown or not checked.",
      ),
      startup_verified: pendingStep("Server startup has not been checked."),
      connection_verified: pendingStep(
        "MCP protocol connection has not been checked.",
      ),
      client_connection_verified: pendingStep(
        "The selected AI client has not been independently observed loading this server.",
      ),
    },
  };
}
