import assert from "node:assert/strict";
import {
  buildDocument,
  events,
  framesAt,
  receipt,
} from "../scenarios/timeline-fleet/author.js";
import type {
  CampaignMode,
  DocumentRun,
} from "../src/timeline/campaign-checks.js";
import { fleetProfile } from "../src/timeline/evidence-versions.js";
import { canonicalJson, encodeJson } from "../src/timeline/json.js";
import { restartEvidence } from "./restart-campaign-evidence.js";

type FleetCounts = {
  assertions: number;
  receipts: number;
  frames: number;
  records: number;
};
export function checkFleetCampaignRun(
  raw: string,
  baseline: DocumentRun | undefined,
  mode: CampaignMode,
  expected: FleetCounts,
) {
  const { run, parsed, byKind } = restartEvidence(raw, baseline, "memory");
  assert.equal(parsed.scenario.profile, fleetProfile, "fleet scenario profile");
  assert.equal(run.execution.profile, fleetProfile, "fleet execution profile");
  assert.equal(
    run.scenario,
    canonicalJson(JSON.stringify(buildDocument())),
    "authored fleet document identity",
  );
  assert.equal(
    parsed.lines.length,
    expected.records,
    "complete fleet record count",
  );
  const assertions = byKind("assertion");
  const wanted = buildDocument().assertions;
  assert.equal(
    assertions.length,
    expected.assertions,
    "complete fleet assertion count",
  );
  assert.deepEqual(
    assertions.map(({ time, data }) => [time, data.assertionId]),
    wanted.map((item) => [item.atMs, item.id]),
    "all authored fleet assertions",
  );
  assertions.forEach((event, index) => {
    assert.equal(event.data.passed, true, "fleet assertion did not pass");
    assert.equal(
      encodeJson(event.data.actual),
      canonicalJson(JSON.stringify(wanted[index].expected)),
      "independent complete fleet expectation",
    );
  });
  const receipts = byKind("receipt");
  assert.equal(receipts.length, expected.receipts, "complete receipt count");
  assert.deepEqual(
    receipts.map((event) => [event.time, encodeJson(event.data.envelope)]),
    events.map((event) => [
      event.at,
      canonicalJson(JSON.stringify(receipt(event))),
    ]),
    "independent complete fleet receipts",
  );
  const frames = byKind("delivered").filter(
    (event) => event.data.channel === "client-frame",
  );
  assert.equal(frames.length, expected.frames, "complete client frame count");
  assert.deepEqual(
    frames.map((event) => encodeJson(event.data.envelope)),
    framesAt(450).map((value) => canonicalJson(JSON.stringify(value))),
    "independent complete fleet client frames",
  );

  const { hostDelayMs, paced, idlePauseMs, generations } = run.diagnostics;
  assert.deepEqual(
    [hostDelayMs, paced, idlePauseMs],
    [mode.hostDelay, mode.paced, mode.idlePauseMs],
    "requested Node timing mode",
  );
  assert.deepEqual(
    generations?.map((item) => item.runtimeGeneration),
    [1],
    "single fleet runtime generation",
  );
  const timing = generations![0];
  assert.equal(
    timing.jvm?.pauseMillis,
    mode.jvmPauseMs,
    "requested JVM timing mode",
  );
  assert.deepEqual(
    timing.jvm?.pauses.map((pause) => [pause.site, pause.virtualMs]).sort(),
    mode.jvmPauseMs
      ? [
          ["state-effect", 60],
          ["writer-handoff", 0],
        ]
      : [],
    "actual JVM state and writer pauses",
  );
  for (const pause of timing.jvm!.pauses) {
    assert.equal(pause.requestedMillis, mode.jvmPauseMs);
    assert.ok(
      Number.isSafeInteger(pause.elapsedNanos) &&
        pause.elapsedNanos >= mode.jvmPauseMs * 1_000_000,
      "measured JVM pause too short",
    );
  }
  if (mode.hostDelay) {
    assert.ok(timing.node.length > 0, "missing Node pauses");
    for (const pause of timing.node) {
      assert.equal(pause.requestedMillis, mode.hostDelay);
      assert.ok(
        Number.isSafeInteger(pause.elapsedNanos) &&
          pause.elapsedNanos > 50_000_000,
        "measured Node pause too short",
      );
    }
    assert.ok(
      timing.node.some(
        (pause) => pause.operation === "ingress" && pause.timeMs === 240,
      ),
      "missing pause during late publication",
    );
  } else {
    assert.deepEqual(timing.node, [], "unexpected Node pauses");
  }
  return run;
}
