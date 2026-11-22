import { isDeepStrictEqual } from "node:util";
import { nextSlot, resolveRates } from "./plan.js";
import { Workload } from "../workload.js";
import {
  campaignLimits,
  type CampaignManifest,
  type Completion,
  type JournalState,
} from "./model.js";

export function requireState(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error("Invalid campaign: " + message);
}
const finite = (n: number) => Number.isFinite(n) && n >= 0;
export const validRate = (n: number | undefined) =>
  [10, 30, 100, 300, 1000].includes(n ?? 0);
export const adminQuantumMs = 60_000;
export const waitReserveMs = 60_000;
export const attemptId = (index: number) =>
  "attempt-" + String(index + 1).padStart(3, "0");
const stringMap = (value: unknown) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.values(value).every((v) => typeof v === "string");

export function checkManifest(m: CampaignManifest) {
  requireState(
    m.format === "benchmark-campaign/v1" &&
      typeof m.campaignId === "string" &&
      m.campaignId.length &&
      stringMap(m.identity) &&
      Object.keys(m.identity).length &&
      m.selectionRule,
    "manifest identity",
  );
  requireState(
    isDeepStrictEqual(m.limits, campaignLimits) &&
      m.slots.length > 0 &&
      m.slots.length <= campaignLimits.slots,
    "manifest limits",
  );
  const ids = new Set<string>();
  for (const s of m.slots) {
    requireState(
      typeof s.id === "string" && s.id.length && !ids.has(s.id),
      "duplicate or empty slot ID",
    );
    ids.add(s.id);
    requireState(
      [
        "baseline",
        "resident",
        "senders",
        "views",
        "payload",
        "viewers",
      ].includes(s.variant) &&
        s.storage === s.workload.storage &&
        Number.isInteger(s.replicate) &&
        s.replicate >= 1 &&
        s.replicate <= 3 &&
        (s.variant === "baseline"
          ? validRate(s.baselineRate)
          : s.baselineRate === undefined),
      "slot shape",
    );
    new Workload(s.workload);
  }
}
export function checkCompletion(c: Completion, id: string) {
  requireState(
    c.id === id &&
      [
        "pass",
        "service-budget",
        "correctness",
        "harness-limited",
        "infrastructure",
      ].includes(c.outcome) &&
      typeof c.reason === "string" &&
      finite(c.elapsedMs) &&
      Array.isArray(c.artifacts),
    "completion metadata",
  );
}
export function checkState(s: JournalState, manifest: CampaignManifest) {
  requireState(
    Array.isArray(s.sessions) &&
      Array.isArray(s.attempts) &&
      Array.isArray(s.charges),
    "state shape",
  );
  const priorBySlot = new Map<string, (typeof s.attempts)[number]>();
  for (const [i, session] of s.sessions.entries()) {
    requireState(
      session.id === i + 1 &&
        Number.isFinite(Date.parse(session.startedUtc)) &&
        stringMap(session.conditions),
      "session metadata",
    );
    requireState(
      session.endedUtc || session.recoveredUtc
        ? Number.isFinite(
            Date.parse((session.endedUtc ?? session.recoveredUtc)!),
          ) && typeof session.reason === "string"
        : i === s.sessions.length - 1 && !session.reason,
      "session closure",
    );
  }
  for (const [i, a] of s.attempts.entries()) {
    const slot = manifest.slots.find((slot) => slot.id === a.slotId);
    requireState(
      a.id === attemptId(i) &&
        slot &&
        s.sessions[a.sessionId - 1]?.id === a.sessionId &&
        validRate(a.rate) &&
        (slot.baselineRate ?? s.resolution?.rates[slot.storage]) === a.rate,
      "attempt identity or rate",
    );
    const prior = priorBySlot.get(a.slotId);
    requireState(
      prior?.id === a.replaces &&
        (!prior ||
          prior.status === "interrupted" ||
          prior.completion?.outcome === "infrastructure"),
      "replacement relation",
    );
    priorBySlot.set(a.slotId, a);
    if (a.status === "completed") {
      requireState(
        a.completion &&
          a.completionHash &&
          /^[a-f0-9]{64}$/.test(a.completionHash),
        "completion reference",
      );
      checkCompletion(a.completion, a.id);
    } else
      requireState(
        (a.status === "interrupted" ||
          (a.status === "running" && i === s.attempts.length - 1)) &&
          !a.completion &&
          !a.completionHash,
        "attempt lifecycle",
      );
  }
  requireState(
    s.attempts.length - priorBySlot.size <= manifest.limits.replacements,
    "replacement limit",
  );
  const charged = new Set<string>();
  let previousSession = 0;
  let spentMs = 0;
  for (const [i, c] of s.charges.entries()) {
    const session = s.sessions[c.sessionId - 1];
    requireState(
      session?.id === c.sessionId &&
        c.sessionId >= previousSession &&
        finite(c.reservedMs) &&
        c.reservedMs > 0,
      "reservation",
    );
    requireState(
      spentMs + c.reservedMs <= manifest.limits.activeMs,
      "reservation exceeded available active budget",
    );
    requireState(
      c.elapsedMs === undefined ||
        c.elapsedMs <= c.reservedMs ||
        !!s.stopReason,
      "settled duration exceeds reservation without a campaign stop",
    );
    spentMs += c.elapsedMs ?? c.reservedMs;
    previousSession = c.sessionId;
    requireState(
      c.elapsedMs === undefined
        ? i === s.charges.length - 1 &&
            !(session.endedUtc || session.recoveredUtc)
        : finite(c.elapsedMs),
      "unsettled reservation",
    );
    if (c.kind === "attempt") {
      const a = s.attempts.find((a) => a.id === c.attemptId);
      requireState(
        a &&
          !charged.has(a.id) &&
          c.sessionId === a.sessionId &&
          c.reservedMs === campaignLimits.attemptMs,
        "attempt reservation",
      );
      requireState(
        a.status === "completed"
          ? c.elapsedMs === a.completion?.elapsedMs
          : a.status === "running"
            ? c.elapsedMs === undefined
            : c.elapsedMs !== undefined && c.interrupted,
        "attempt accounting",
      );
      charged.add(a.id);
    } else {
      requireState(
        !c.attemptId &&
          (c.kind === "admin"
            ? c.reservedMs <= adminQuantumMs
            : c.kind === "wait" && c.reservedMs === waitReserveMs),
        "administration or settling reservation",
      );
    }
  }
  requireState(
    charged.size === s.attempts.length,
    "missing attempt reservations",
  );
  // Replay the frozen slot order. A locally coherent attempt can still belong to
  // the wrong point in the schedule, or cite a rate derived from the wrong evidence.
  const replay: JournalState = { attempts: [], sessions: [], charges: [] };
  let replacements = 0;
  for (const a of s.attempts) {
    let next = nextSlot(manifest, replay, replacements);
    if (next?.needsResolution) {
      requireState(
        s.resolution &&
          isDeepStrictEqual(s.resolution, resolveRates(manifest, replay)),
        "invalid saved comparison resolution",
      );
      replay.resolution = s.resolution;
      next = nextSlot(manifest, replay, replacements);
    }
    requireState(
      next?.slot?.id === a.slotId && next.rate === a.rate,
      "recorded attempt violates frozen schedule",
    );
    replay.attempts.push(a);
    if (a.replaces) replacements++;
  }
  if (s.resolution && !replay.resolution) {
    requireState(
      nextSlot(manifest, replay, replacements)?.needsResolution &&
        isDeepStrictEqual(s.resolution, resolveRates(manifest, replay)),
      "invalid saved comparison resolution",
    );
  }
}
