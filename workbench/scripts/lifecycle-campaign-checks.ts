import assert from "node:assert/strict";
import type {
  CampaignMode,
  DocumentRun,
} from "../src/timeline/campaign-checks.js";
import { encodeJson } from "../src/timeline/json.js";
import { integer, list, object } from "../src/timeline/validation.js";
import type { LifecycleExpectation } from "./lifecycle-campaign-inputs.js";

import { restartEvidence } from "./restart-campaign-evidence.js";

const epoch = 1_700_000_000_000;
const freshnessThresholdMs = 30;

export function checkLifecycleCampaignRun(
  raw: string,
  baseline: DocumentRun | undefined,
  mode: CampaignMode,
  expected: LifecycleExpectation,
) {
  const { run, parsed, byKind } = restartEvidence(raw, baseline, "memory");
  assert.deepEqual(
    byKind("runtime-initialized").map((event) => [
      event.generation,
      event.time,
      integer(event.data.monotonicMs, "monotonicMs"),
      integer(event.data.wallMillis, "wallMillis"),
    ]),
    [
      [1, 0, 0, epoch],
      [2, expected.restart, 0, epoch + expected.restart],
    ],
    "independent initialization clocks",
  );
  const stops = byKind("action").filter(
    (event) => event.data.actionKind === "service-stop",
  );
  assert.deepEqual(
    stops.map((event) => [event.time, event.generation, event.data.mode]),
    [[expected.stop.atMs, 1, expected.stop.mode]],
    "declared stop",
  );
  const stopId = stops[0].id;

  assert.deepEqual(
    byKind("attempt-outcome").map((event) => [
      event.time,
      integer(event.data.attempt, "attempt"),
      event.data.publication,
      event.generation,
      event.connection,
      event.causes,
    ]),
    expected.attemptsUnavailable.map(([at, attempt]) => [
      at,
      attempt,
      "report-1",
      null,
      null,
      [stopId],
    ]),
    "unavailable attempts",
  );
  assert.deepEqual(
    byKind("fault-decision").map((event) => [
      event.time,
      event.generation,
      event.connection,
      integer(event.data.attempt, "attempt"),
      event.data.lost,
      event.data.digest,
    ]),
    expected.draws,
    "independent receipt-loss draw vectors",
  );
  const reconnects = byKind("retry-lifecycle").filter(
    (event) => event.data.operation === "connect",
  );
  assert.deepEqual(
    reconnects.map((event) => [
      event.time,
      integer(event.data.attempt, "attempt"),
      event.connection,
      event.generation,
    ]),
    [[...expected.retry, 2]],
    "restart reconnect attempt and connection identity",
  );

  const [firstApplied, secondApplied] = expected.applied;
  const states = byKind("state");
  assert.deepEqual(
    states.map((event) => {
      const envelope = object(event.data.envelope, "state envelope");
      const status = object(envelope.status, "status");
      const field = object(object(status.fields, "fields").reading, "reading");
      return [
        event.generation,
        event.time,
        integer(envelope.version, "version"),
        field.freshness,
        integer(field.receivedAtMillis, "receivedAtMillis"),
      ];
    }),
    [
      ...(firstApplied < 0
        ? []
        : [[1, firstApplied, 1, "fresh", epoch + firstApplied]]),
      [2, secondApplied, 1, "fresh", epoch + secondApplied],
      [2, expected.expiry[1], 2, "stale", epoch + secondApplied],
    ],
    "independent freshness transitions and receipt clocks",
  );
  const alarms = byKind("scheduled").filter(
    (event) => event.data.taskKind === "alarm",
  );
  assert.deepEqual(
    alarms.map((event) => [
      event.generation,
      integer(event.data.atMs, "alarm deadline"),
    ]),
    expected.expiry.flatMap((time, i) => (time < 0 ? [] : [[i + 1, time]])),
    "independent global alarm deadlines",
  );
  const firstAlarm = alarms.find((event) => event.generation === 1);
  if (firstAlarm)
    assert.ok(
      byKind("cancelled").some(
        (event) =>
          event.parent === stopId && event.causes.includes(firstAlarm.id),
      ),
      "stop cancels original alarm",
    );
  const newAlarm = alarms.find((event) => event.generation === 2);
  assert.ok(
    newAlarm &&
      byKind("task-dispatched").some(
        (event) =>
          event.parent === newAlarm.id && event.time === expected.expiry[1],
      ),
    "new alarm actually dispatches",
  );

  if (expected.retiredReceiptAt !== undefined) {
    const drops = byKind("dropped").filter(
      (event) =>
        event.parent === stopId && event.data.channel === "source-receipt",
    );
    assert.deepEqual(
      drops.map((event) => [event.time, event.generation, event.connection]),
      [[expected.retiredReceiptAt, 1, 1]],
      "old receipt invalidated at stop",
    );
    assert.ok(
      byKind("task-dispatched").some(
        (event) =>
          event.time === expected.retry[0] &&
          event.generation === null &&
          event.connection === null,
      ),
      "source timer survives restart",
    );
  }

  const authored = list(parsed.scenario.document.assertions, "assertions").map(
    (item) => object(item, "assertion"),
  );
  assert.deepEqual(
    byKind("assertion").map((event) => {
      const declared = authored.find(
        (item) => item.id === event.data.assertionId,
      );
      assert.ok(declared, "assertion names a scenario expectation");
      assert.equal(
        event.data.passed,
        true,
        "authored scenario assertion failed",
      );
      assert.equal(
        encodeJson(event.data.actual),
        encodeJson(declared.expected),
        "actual observation differs from authored envelope",
      );
      return [
        event.data.assertionId,
        event.time,
        list(event.data.actual, "observation").length,
      ];
    }),
    expected.assertions,
    "every literal assertion ran at its scheduled time",
  );

  checkPauses(run, mode, expected);
  return run;
}

function checkPauses(
  run: DocumentRun,
  mode: CampaignMode,
  expected: LifecycleExpectation,
) {
  assert.deepEqual(
    {
      hostDelay: run.diagnostics.hostDelayMs,
      paced: run.diagnostics.paced,
      idlePauseMs: run.diagnostics.idlePauseMs,
    },
    {
      hostDelay: mode.hostDelay,
      paced: mode.paced,
      idlePauseMs: mode.idlePauseMs,
    },
    "requested Node timing mode",
  );
  const generations = run.diagnostics.generations;
  assert.deepEqual(
    generations?.map((generation) => generation.runtimeGeneration),
    [1, 2],
    "timing diagnostics cover both runtime generations",
  );
  if (mode.hostDelay)
    assert.ok(
      mode.hostDelay > freshnessThresholdMs,
      "Node perturbation must exceed freshness threshold",
    );
  if (mode.jvmPauseMs)
    assert.ok(
      mode.jvmPauseMs > freshnessThresholdMs,
      "JVM perturbation must exceed freshness threshold",
    );
  for (const [index, generation] of generations!.entries()) {
    const sites = expected.pauses[index];
    assert.equal(
      generation.jvm?.pauseMillis,
      mode.jvmPauseMs,
      "requested JVM timing mode",
    );
    assert.deepEqual(
      generation.jvm?.pauses
        .map((pause) => [pause.site, pause.virtualMs])
        .sort(),
      mode.jvmPauseMs ? Object.entries(sites).sort() : [],
      "JVM pause sites and virtual times",
    );
    assert.ok(
      generation.jvm?.pauses.every(
        (pause) =>
          pause.requestedMillis === mode.jvmPauseMs &&
          Number.isSafeInteger(pause.elapsedNanos) &&
          pause.elapsedNanos >= mode.jvmPauseMs * 1_000_000,
      ),
      "observed JVM pause duration",
    );

    if (!mode.hostDelay)
      assert.deepEqual(
        generation.node,
        [],
        "unpaused Node has no command delay",
      );
    else {
      assert.ok(
        generation.node.length > 0 &&
          generation.node.every(
            (pause) =>
              pause.requestedMillis === mode.hostDelay &&
              Number.isSafeInteger(pause.elapsedNanos) &&
              pause.elapsedNanos > freshnessThresholdMs * 1_000_000,
          ),
        "observed Node pause duration",
      );
      if (index === 1) {
        const commands = generation.node.filter(
          (pause) => pause.timeMs === expected.applied[1],
        );
        assert.ok(
          commands.length > 1 &&
            commands.some((pause) => pause.operation === "ingress"),
          "restarted ingress had a measured Node pause at the same virtual time as another command",
        );
      }
    }
  }
}
