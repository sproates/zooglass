import { type Json } from "./json.js";
import { choice } from "./validation.js";

export const orderProfile = "sqlite-order-v1";
export const orderRestartProfile = "sqlite-order-restart-v1";
export function isOrderProfile(
  profile: unknown,
): profile is typeof orderProfile | typeof orderRestartProfile {
  return profile === orderProfile || profile === orderRestartProfile;
}

export const sportsProfile = "sqlite-sports-v1";
export function hasProgressControl(profile: unknown) {
  return isOrderProfile(profile) || profile === sportsProfile;
}

export const staticViewsProfile = "memory-static-views-v1";

export const fleetProfile = "memory-sequence-fleet-v1";

export const evidenceV1 = {
  scenario: "timeline-simulation/v1",
  trace: "timeline-trace/v1",
  run: "timeline-run/v1",
  bundle: "timeline-bundle/v1",
  profile: "memory-arrival-v1",
  protocol: 1,
} as const;

export const evidenceV2 = {
  scenario: "timeline-simulation/v2",
  trace: "timeline-trace/v2",
  run: "timeline-run/v2",
  bundle: "timeline-bundle/v2",
  profile: "receipt-age-restart-v1",
  protocol: 2,
} as const;

/** Static-view documents retain an explicit identity across all evidence formats. */
export const evidenceV3 = {
  scenario: "timeline-simulation/v3",
  trace: "timeline-trace/v3",
  run: "timeline-run/v3",
  bundle: "timeline-bundle/v3",
  profile: staticViewsProfile,
  protocol: 2,
} as const;

export type EvidenceVersions =
  typeof evidenceV1 | typeof evidenceV2 | typeof evidenceV3;
export function documentEvidenceVersions(
  format: Json | undefined,
): EvidenceVersions {
  const admitted = choice(format, "$.format", [
    evidenceV1.scenario,
    evidenceV2.scenario,
    evidenceV3.scenario,
  ]);
  return admitted === evidenceV3.scenario
    ? evidenceV3
    : admitted === evidenceV2.scenario
      ? evidenceV2
      : evidenceV1;
}
