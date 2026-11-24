import { createJsonClientAdapters } from "./json-client-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import type { ClientAdapter, ClientId } from "./types.js";

export function getClientAdapters(): ClientAdapter[] {
  return [...createJsonClientAdapters(), new CodexAdapter()];
}
export function getClientAdapter(id: string): ClientAdapter {
  const client = getClientAdapters().find((item) => item.id === id.toLowerCase());
  if (!client) throw new Error(`Unsupported client “${id}”. Choose claude, codex, or cursor.`);
  return client;
}
export function isClientId(value: string): value is ClientId {
  return ["claude", "codex", "cursor"].includes(value.toLowerCase());
}
