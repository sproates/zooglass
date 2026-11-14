import assert from "node:assert/strict";
import type {
  CampaignMode,
  DocumentRun,
} from "../src/timeline/campaign-checks.js";
import { encodeJson, type Json } from "../src/timeline/json.js";
import { integer, list, object } from "../src/timeline/validation.js";
import type { SqliteExpectation } from "./sqlite-campaign-inputs.js";

import { restartEvidence } from "./restart-campaign-evidence.js";

const epoch = 1_700_000_000_000;

function snapshot(value: Json) {
  const envelope = object(value, "snapshot");
  const status = object(envelope.status, "status");
  const field = object(object(status.fields, "fields").reading, "reading");
  return [
    envelope.entityId,
    integer(envelope.version, "version"),
    field.freshness,
    field.receivedAtMillis === null
      ? null
      : integer(field.receivedAtMillis, "receipt wall clock"),
  ];
}

export function checkSqliteCampaignRun(
  raw: string,
  baseline: DocumentRun | undefined,
  mode: CampaignMode,
  expected: SqliteExpectation,
) {
  const { run, parsed, byKind } = restartEvidence(raw, baseline, "sqlite");
  assert.equal(
    run.diagnostics.retainedStore,
    undefined,
    "passing SQLite run retained a database",
  );
  assert.match(
    run.environment.java.sqliteVersion,
    /^\d+\.\d+\.\d+/,
    "native SQLite version identity",
  );
  const initializations = byKind("runtime-initialized");
  assert.deepEqual(
    initializations.map((event) => [
      event.generation,
      event.time,
      integer(event.data.wallMillis, "initialization wall"),
      integer(event.data.monotonicMs, "monotonic clock"),
    ]),
    [
      [1, 0, epoch, 0],
      [2, ...expected.restart, 0],
    ],
    "independent initialization clocks",
  );
  const emptyTargets = parsed.scenario.observationTargets.map(
    ({ entityId }) => [entityId, 0, "absent", null],
  );
  assert.deepEqual(
    list(initializations[0].data.snapshots, "initial snapshots").map(snapshot),
    emptyTargets,
    "private store starts empty",
  );
  assert.deepEqual(
    list(initializations[1].data.snapshots, "restart snapshots").map(snapshot),
    expected.snapshots,
    "independent installed recovery snapshots",
  );

  const controls = byKind("action");
  const stops = controls.filter(
    ({ data }) => data.actionKind === "service-stop",
  );
  assert.deepEqual(
    stops.map((event) => [event.time, event.generation, event.data.mode]),
    [[expected.stopAt, 1, "abrupt"]],
    "declared abrupt stop",
  );
  const stopId = stops[0].id;
  assert.deepEqual(
    controls
      .filter(({ data }) => data.actionKind === "wall-clock-set")
      .map((event) => [
        event.time,
        event.generation,
        integer(event.data.wallMillis, "wall setting"),
      ]),
    expected.wallAction ? [expected.wallAction] : [],
    "independent wall adjustment",
  );
  assert.deepEqual(
    byKind("state").map((event) => [
      event.generation,
      event.time,
      ...snapshot(event.data.envelope),
    ]),
    expected.states,
    "independent state, freshness and receipt-clock transitions",
  );
  assert.deepEqual(
    byKind("receipt").map((event) => {
      const receipt = object(event.data.envelope, "receipt");
      return [
        event.generation,
        event.time,
        receipt.status,
        receipt.reason,
        integer(receipt.version, "receipt version"),
      ];
    }),
    expected.receipts,
    "independent durable receipts and original duplicate version",
  );

  const alarms = byKind("scheduled").filter(
    ({ data }) => data.taskKind === "alarm",
  );
  assert.deepEqual(
    alarms.map((event) => [
      event.generation,
      integer(event.data.atMs, "alarm due"),
    ]),
    expected.alarms,
    "independent global alarm deadlines",
  );
  assert.deepEqual(
    byKind("task-dispatched")
      .filter((event) => alarms.some((alarm) => alarm.id === event.parent))
      .map((event) => [event.generation, event.time]),
    expected.alarms.filter(([generation]) => generation === 2),
    "only fresh-generation alarms dispatch",
  );
  assert.ok(
    byKind("cancelled").some(
      (event) => event.parent === stopId && event.causes.includes(alarms[0].id),
    ),
    "original alarm retired at stop",
  );

  const retry = expected.retry;
  if (retry) {
    assert.deepEqual(
      byKind("receipt").map((event) => encodeJson(event.data.envelope)),
      retry.envelopes,
      "complete original and duplicate durable receipts",
    );
    assert.deepEqual(
      byKind("delivered")
        .filter((event) => event.data.channel === "source-receipt")
        .map((event) => encodeJson(event.data.envelope)),
      [retry.envelopes[1]],
      "only the full durable duplicate reaches the source",
    );
  }
  assert.deepEqual(
    byKind("scheduled")
      .filter(
        ({ data }) =>
          typeof data.taskKind === "string" &&
          data.taskKind.startsWith("source-"),
      )
      .map((event) => [
        event.time,
        integer(event.data.atMs, "timer due"),
        event.data.taskKind,
      ]),
    retry?.timers ?? [],
    "independent retry timer schedule",
  );
  assert.deepEqual(
    byKind("retry-status").map((event) => [
      event.time,
      integer(event.data.attempt, "attempt"),
      event.data.status,
    ]),
    retry?.statuses ?? [],
    "independent retry statuses",
  );
  assert.deepEqual(
    byKind("attempt-outcome").map((event) => [
      event.time,
      integer(event.data.attempt, "attempt"),
      event.generation,
      event.connection,
      event.causes,
    ]),
    retry ? [[...retry.unavailable, null, null, [stopId]]] : [],
    "unavailable attempts",
  );
  const sentAttempts = byKind("retry-attempt").filter(
    (event) => event.generation !== null,
  );
  assert.deepEqual(
    sentAttempts.map((event) => [
      event.time,
      integer(event.data.attempt, "attempt"),
      event.connection,
      event.generation,
    ]),
    retry ? [[...retry.delivered, 2]] : [],
    "available retry uses its true attempt and new connection",
  );
  assert.deepEqual(
    byKind("fault-decision").map((event) => [
      event.time,
      integer(event.data.attempt, "attempt"),
      event.data.lost,
      event.data.digest,
    ]),
    retry?.draws ?? [],
    "independent receipt-loss draw vectors",
  );

  const authored = list(parsed.scenario.document.assertions, "assertions").map(
    (value) => object(value, "authored assertion"),
  );
  const assertions = byKind("assertion");
  assert.deepEqual(
    assertions.map((event) => [event.data.assertionId, event.time]),
    expected.assertions,
    "all qualified scenario assertions ran",
  );
  for (const event of assertions) {
    const wanted = authored.find((item) => item.id === event.data.assertionId);
    assert.ok(wanted, "event identifies an authored assertion");
    assert.equal(event.data.passed, true, "authored scenario assertion failed");
    assert.equal(
      encodeJson(event.data.actual),
      encodeJson(wanted.expected),
      "complete observation differs from authored expectation",
    );
  }
  checkPauses(run, mode, expected);
  return run;
}

function checkPauses(
  run: DocumentRun,
  mode: CampaignMode,
  expected: SqliteExpectation,
) {
  const { hostDelayMs, paced, idlePauseMs, generations } = run.diagnostics;
  assert.deepEqual(
    [hostDelayMs, paced, idlePauseMs],
    [mode.hostDelay, mode.paced, mode.idlePauseMs],
    "requested Node timing mode",
  );
  assert.deepEqual(
    generations?.map((item) => item.runtimeGeneration),
    [1, 2],
    "timing diagnostics cover both generations",
  );
  const threshold = expected.thresholdMs;
  if (mode.hostDelay || mode.jvmPauseMs)
    assert.ok(
      mode.hostDelay > threshold && mode.jvmPauseMs > threshold,
      "requested pauses must exceed freshness threshold",
    );
  for (const [index, item] of generations!.entries()) {
    assert.equal(
      item.jvm?.pauseMillis,
      mode.jvmPauseMs,
      "requested JVM timing mode",
    );
    const sites = mode.jvmPauseMs
      ? Object.entries(expected.pauseTimes[index]).sort()
      : [];
    assert.deepEqual(
      item.jvm?.pauses.map((pause) => [pause.site, pause.virtualMs]).sort(),
      sites,
      "measured JVM pause sites and times",
    );
    for (const pause of item.jvm!.pauses)
      assert.ok(
        pause.requestedMillis === mode.jvmPauseMs &&
          Number.isSafeInteger(pause.elapsedNanos) &&
          pause.elapsedNanos >= mode.jvmPauseMs * 1_000_000,
        "measured JVM pause duration",
      );
    if (mode.hostDelay) {
      assert.ok(
        item.node.length &&
          item.node.every(
            (pause) =>
              pause.requestedMillis === mode.hostDelay &&
              Number.isSafeInteger(pause.elapsedNanos) &&
              pause.elapsedNanos > threshold * 1_000_000,
          ),
        "measured Node delay exceeds freshness threshold",
      );
      if (index === 1) {
        const [operation, time] = expected.restartCommand;
        assert.ok(
          item.node.some(
            (pause) => pause.operation === operation && pause.timeMs === time,
          ),
          "measured Node delay on the selected generation 2 command",
        );
      }
    } else
      assert.deepEqual(item.node, [], "unpaused Node has no command delays");
  }
}
