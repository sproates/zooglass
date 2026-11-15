import assert from "node:assert/strict";
import {
  checkCampaignRun,
  type CampaignMode,
  type DocumentRun,
} from "../src/timeline/campaign-checks.js";
import { parseReplay } from "../src/timeline/replay-document.js";
import { canonicalJson } from "../src/timeline/json.js";
import { staticViewsProfile } from "../src/timeline/evidence-versions.js";

/** Independent literals stay in the reviewed document; baseline equality alone is insufficient. */
export function checkStaticRun(
  run: DocumentRun,
  scenario: string,
  baseline: DocumentRun | undefined,
  mode: CampaignMode,
) {
  const document = JSON.parse(scenario);
  const firstSend = document.actions.find(
    (action: { kind: string }) => action.kind === "source-send",
  ).atMs;
  // A subscriber receives its initial snapshot first; converted clients have no subscriptions.
  const firstSubscription = document.actions.find(
    (action: { kind: string }) => action.kind === "client-subscribe",
  )?.atMs;
  assert.deepEqual(
    run.diagnostics.generations?.map((item) => item.runtimeGeneration),
    [1],
    "single static runtime generation",
  );
  const timing = run.diagnostics.generations![0];
  checkCampaignRun(
    { ...run, diagnostics: { ...run.diagnostics, jvm: timing.jvm ?? null } },
    baseline,
    mode,
    {
      draws: [],
      pauseTimes: {
        "state-effect": firstSend,
        "writer-handoff": firstSubscription ?? firstSend,
      },
    },
  );
  const parsed = parseReplay(JSON.stringify(run));
  assert.equal(parsed.versions.run, "timeline-run/v3");
  assert.equal(run.execution.profile, staticViewsProfile);
  assert.equal(
    run.scenario,
    canonicalJson(scenario),
    "retained reviewed scenario",
  );
  const records = parsed.lines.map((line) => JSON.parse(line));
  const assertions = records.filter((record) => record.kind === "assertion");
  assert.equal(
    assertions.length,
    document.assertions.length,
    "complete authored assertions",
  );
  for (const [index, observed] of assertions.entries()) {
    const expected = document.assertions[index];
    assert.deepEqual(
      [
        observed.key[0],
        observed.data.assertionId,
        observed.data.assertionKind,
        observed.data.passed,
      ],
      [expected.atMs, expected.id, expected.kind, true],
    );
    if (expected.kind !== "source-accepted") {
      assert.equal(
        canonicalJson(JSON.stringify(observed.data.expected)),
        canonicalJson(JSON.stringify(expected.expected)),
        "retained literal expectation",
      );
      assert.equal(
        canonicalJson(JSON.stringify(observed.data.actual)),
        canonicalJson(JSON.stringify(expected.expected)),
        "independent expected observation",
      );
    }
  }
  assert.equal(
    records.filter((record) => record.kind === "receipt").length,
    document.publications.length,
    "one receipt per publication",
  );
  const pauses = timing.node;
  if (!mode.hostDelay) assert.deepEqual(pauses, []);
  else {
    assert.ok(pauses.length > 0, "measured Node pauses missing");
    for (const pause of pauses) {
      assert.equal(pause.requestedMillis, mode.hostDelay);
      assert.ok(
        Number.isSafeInteger(pause.elapsedNanos) &&
          pause.elapsedNanos >= mode.hostDelay * 1_000_000,
        "measured Node pause too short",
      );
    }
    for (const action of document.actions.filter(
      (action: { kind: string }) => action.kind === "source-send",
    ))
      assert.ok(
        pauses.some(
          (pause) =>
            pause.operation === "ingress" && pause.timeMs === action.atMs,
        ),
        "missing in-turn Node pause before publication",
      );
  }
  return {
    records: parsed.lines.length,
    assertions: assertions.length,
    nodePauses: pauses.length,
    jvmPauses: timing.jvm!.pauses.length,
  };
}
