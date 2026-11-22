import { baseline, Workload } from "../workload.js";
import type {
  CampaignManifest,
  CampaignSlot,
  JournalState,
  Resolution,
  Variant,
} from "./model.js";
import { campaignLimits } from "./model.js";
import { createHash } from "node:crypto";

export const rates = [10, 30, 100, 300, 1000];
export const selectionRule =
  "all-three-pass;greatest-passing-at-most-half-highest;otherwise-lowest-passing-no-headroom/v1";

export function makeManifest(
  campaignId: string,
  identity: Record<string, string>,
): CampaignManifest {
  const slots: CampaignSlot[] = [];
  const add = (variant: Variant, rate?: number) => {
    for (let replicate = 1; replicate <= 3; replicate++)
      for (const storage of ["memory", "sqlite"] as const) {
        const workload = {
          ...baseline,
          storage,
          ...(variant === "resident" ? { residentEntities: 10000 } : {}),
          ...(variant === "senders" ? { sourceSockets: 8 } : {}),
          ...(variant === "views" ? { views: 4 } : {}),
          ...(variant === "payload" ? { payloadBytes: 4096 } : {}),
          ...(variant === "viewers" ? { viewers: 8 } : {}),
        };
        slots.push({
          id: `${variant}-${rate ?? "selected"}-${storage}-${replicate}`,
          variant,
          storage,
          replicate,
          ...(rate === undefined ? {} : { baselineRate: rate }),
          workload,
        });
      }
  };
  for (const rate of rates) add("baseline", rate);
  for (const variant of [
    "resident",
    "senders",
    "views",
    "payload",
    "viewers",
  ] as const)
    add(variant);
  const configurations = slots.map((slot) => ({
    id: slot.id,
    configuration: new Workload(slot.workload).configuration,
    workload: slot.workload,
  }));
  return {
    format: "benchmark-campaign/v1",
    campaignId,
    identity: {
      ...identity,
      inputs: createHash("sha256")
        .update(JSON.stringify(configurations))
        .digest("hex"),
    },
    slots,
    limits: campaignLimits,
    selectionRule,
  };
}

export function resolveRates(
  manifest: CampaignManifest,
  state: JournalState,
): Resolution {
  const evidence: Record<string, string> = {};
  const selected: Resolution["rates"] = { memory: null, sqlite: null };
  for (const storage of ["memory", "sqlite"] as const) {
    const passing = rates.filter((rate) => {
      const slots = manifest.slots.filter(
        (s) => s.storage === storage && s.baselineRate === rate,
      );
      return (
        slots.length === 3 &&
        slots.every((slot) => {
          const attempt = state.attempts
            .filter((a) => a.slotId === slot.id)
            .at(-1);
          return attempt?.completion?.outcome === "pass";
        })
      );
    });
    const highest = passing.at(-1);
    if (highest !== undefined)
      selected[storage] =
        passing.filter((r) => r <= highest / 2).at(-1) ?? passing[0];
  }
  for (const slot of manifest.slots.filter((s) => s.variant === "baseline")) {
    const attempt = state.attempts.filter((a) => a.slotId === slot.id).at(-1);
    evidence[slot.id] =
      attempt?.completionHash ??
      "incomplete: no validated completion within campaign limits";
  }
  return { rates: selected, evidence };
}

export function nextSlot(
  manifest: CampaignManifest,
  state: JournalState,
  replacements: number,
) {
  for (const slot of manifest.slots) {
    if (slot.variant !== "baseline" && !state.resolution)
      return { needsResolution: true as const };
    const rate = slot.baselineRate ?? state.resolution?.rates[slot.storage];
    if (rate == null) continue;
    const previous = state.attempts.filter((a) => a.slotId === slot.id).at(-1);
    if (
      previous &&
      previous.completion?.outcome !== "infrastructure" &&
      previous.status !== "interrupted"
    )
      continue;
    if (previous && replacements >= manifest.limits.replacements) continue;
    return { slot, rate };
  }
  return null;
}
