import { type Json } from "./json.js";
import { choice } from "./validation.js";

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

export function documentEvidenceVersions(format: Json | undefined) {
  return choice(format, "$.format", [
    evidenceV1.scenario,
    evidenceV2.scenario,
  ]) === evidenceV2.scenario
    ? evidenceV2
    : evidenceV1;
}
