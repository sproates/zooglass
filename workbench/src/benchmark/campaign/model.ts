import type { clientDiagnostic } from "../diagnostic.js";
import type { WorkloadOptions } from "../workload.js";

export type Storage = WorkloadOptions["storage"];
export type Variant =
  "baseline" | "resident" | "senders" | "views" | "payload" | "viewers";
export type Outcome =
  | "pass"
  | "service-budget"
  | "correctness"
  | "harness-limited"
  | "infrastructure";
export const campaignLimits = {
  slots: 60,
  replacements: 6,
  activeMs: 8 * 60 * 60_000,
  attemptMs: 30 * 60_000,
  settleMs: 30_000,
} as const;

export interface CampaignSlot {
  id: string;
  variant: Variant;
  storage: Storage;
  replicate: number;
  baselineRate?: number;
  workload: WorkloadOptions;
}
export interface CampaignManifest {
  format: "benchmark-campaign/v1";
  campaignId: string;
  identity: Record<string, string>;
  slots: CampaignSlot[];
  limits: typeof campaignLimits;
  selectionRule: string;
}
export interface Resolution {
  rates: Record<Storage, number | null>;
  /** Slot ID to completion SHA-256, or an explicit reason for an incomplete slot. */
  evidence: Record<string, string>;
}
export type Diagnostic = Awaited<ReturnType<typeof clientDiagnostic>>;
export interface Artifact {
  name: string;
  bytes: number;
  sha256: string;
}
export interface Completion {
  inputHash: string;
  id: string;
  outcome: Outcome;
  reason: string;
  elapsedMs: number;
  artifacts: Artifact[];
}
export interface Attempt {
  id: string;
  slotId: string;
  rate: number;
  sessionId: number;
  replaces?: string;
  status: "running" | "completed" | "interrupted";
  completion?: Completion;
  completionHash?: string;
}
export interface Session {
  id: number;
  startedUtc: string;
  endedUtc?: string;
  reason?: string;
  conditions: Record<string, string>;
  clientDiagnostics?: Partial<Record<Variant, Diagnostic>>;
  recoveredUtc?: string;
}
export interface Charge {
  kind: "admin" | "wait" | "attempt";
  sessionId: number;
  attemptId?: string;
  reservedMs: number;
  elapsedMs?: number;
  interrupted?: boolean;
}
export interface JournalState {
  attempts: Attempt[];
  sessions: Session[];
  charges: Charge[];
  resolution?: Resolution;
  stopReason?: string;
}
export interface AttemptToken {
  clientDiagnostic?: Diagnostic;
  id: string;
  slot: CampaignSlot;
  rate: number;
  directory: string;
}
export type VerifyResult = (
  token: AttemptToken,
  completion: Completion,
  checkpoint: () => Promise<void>,
) => Promise<void>;

export interface StartupFailure {
  status: "failed-before-result";
  error: string;
  code?: string;
  syscall?: string;
}

export function startupFailure(cause: unknown): StartupFailure {
  const error = cause as NodeJS.ErrnoException | null;
  return {
    status: "failed-before-result",
    error: String(cause),
    ...(typeof error?.code === "string" ? { code: error.code } : {}),
    ...(typeof error?.syscall === "string" ? { syscall: error.syscall } : {}),
  };
}

/** Only directly evidenced OS failure to spawn earns an infrastructure replacement. */
export function startupOutcome(
  failure: StartupFailure,
): "infrastructure" | "correctness" {
  return typeof failure.syscall === "string" &&
    failure.syscall.startsWith("spawn ") &&
    ["EAGAIN", "ENOMEM", "EMFILE", "ENFILE", "ENOENT"].includes(
      failure.code ?? "",
    )
    ? "infrastructure"
    : "correctness";
}
