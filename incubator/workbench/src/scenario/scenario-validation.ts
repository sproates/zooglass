import type { ClientState } from "./scenario-model.js";

const clientStates: ClientState[] = [
  "connecting",
  "connected",
  "disconnecting",
  "disconnected",
];

export function isClientState(value: unknown): value is ClientState {
  return clientStates.some((state) => state === value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected ${field} to be a non-empty string.`);
  }

  return value;
}
