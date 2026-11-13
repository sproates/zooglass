import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { inspectAdmission } from "../../src/timeline/admission.js";
import {
  runDocument,
  type DocumentOptions,
} from "../../src/timeline/run-document.js";
import {
  ack,
  action,
  client,
  epoch,
  files,
  fixture,
  frame,
  receipt,
  source,
} from "./document-fixture.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
const stop = (atMs: number, mode: "abrupt" | "orderly" = "abrupt") => ({
  id: "stop",
  kind: "service-stop",
  atMs,
  mode,
});
const start = (atMs: number) => ({ id: "start", kind: "service-start", atMs });
const sourceConnect = (atMs = 0, id = "source-connect") =>
  action(id, atMs, "connect", source);
const clientConnect = (atMs = 0, id = "client-connect") =>
  action(id, atMs, "connect", client);
const send = (atMs: number, id = "send") =>
  action(id, atMs, "source-send", source, { publication: "report-1" });
const subscribe = (atMs: number, id = "subscribe") =>
  action(id, atMs, "client-subscribe", client, {
    viewId: "stock-view",
    entityId: "sku-4",
  });
const framesAt = (id: string, atMs: number, expected: unknown[]) => ({
  id,
  atMs,
  expected,
  kind: "client-frames",
  actor: client,
});
const receiptsAt = (id: string, atMs: number, expected: unknown[]) => ({
  id,
  atMs,
  expected,
  kind: "source-receipts",
  actor: source,
});
const retryPolicy = {
  action: "send",
  maxAttempts: 3,
  receiptTimeoutMs: 10,
  retryIntervalMs: 0,
  unavailableRetryIntervalMs: 30,
};

type Scenario = {
  actions: object[];
  untilMs: number;
  assertions?: object[];
  retries?: object[];
  faults?: object[];
  seed?: string;
  staleAfterMillis?: number;
  linkLatencyMs?: number;
};

async function scenarioFile(context: TestContext, scenario: Scenario) {
  const input = fixture();
  const { staleAfterMillis = 30, linkLatencyMs = 0, ...document } = scenario;
  input.configuration.views[0].fields.reading.freshness.staleAfterMillis =
    staleAfterMillis;
  input.document.links[0].latencyMs = linkLatencyMs;
  const saved = await files(input, () =>
    JSON.stringify({
      ...input.document,
      format: "timeline-simulation/v2",
      assertions: [],
      ...document,
    }),
  );
  context.after(saved.close);
  return saved.path;
}

function records(trace: string) {
  return trace
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function run(
  context: TestContext,
  scenario: Scenario,
  options: Omit<DocumentOptions, "jar"> = {},
) {
  return runDocument(await scenarioFile(context, scenario), {
    jar,
    ...options,
  });
}

test("v2 admission inspects production configuration and negotiates memory lifecycle without running the scenario", async (context) => {
  const path = await scenarioFile(context, { actions: [stop(0)], untilMs: 0 });
  const inspected = await inspectAdmission(path, jar);
  assert.equal(inspected.format, "timeline-simulation/v2");
  assert.equal(inspected.configuration, "valid");
  assert.equal(inspected.execution, "eligible");
  assert.equal(inspected.documentProfile, "receipt-age-restart-v1");
  assert.equal(inspected.artifactMemoryLifecycle, 1);
  assert.match(inspected.reason, /no actions have been executed/);
});

test("memory restart retries at 50 after an unavailable attempt and starts a new freshness deadline at 80", async (context) => {
  const firstFrames = [ack, frame(), frame(1, 1, "fresh", epoch + 10)];
  const freshFrames = [
    ...firstFrames,
    ack,
    frame(),
    frame(1, 1, "fresh", epoch + 50),
  ];
  const path = await scenarioFile(context, {
    actions: [
      sourceConnect(),
      clientConnect(),
      subscribe(0),
      send(10),
      stop(11),
      start(50),
      clientConnect(50, "new-viewer"),
      subscribe(50, "new-subscription"),
    ],
    untilMs: 80,
    assertions: [
      framesAt("downtime-retains-delivered-frames", 30, firstFrames),
      receiptsAt("downtime-has-no-receipt", 30, []),
      framesAt("fresh-at-79", 79, freshFrames),
      framesAt("stale-at-80", 80, [
        ...freshFrames,
        frame(2, 1, "stale", epoch + 50),
      ]),
      receiptsAt("reapplied-in-empty-memory", 80, [receipt(1, 1)]),
    ],
    retries: [retryPolicy],
    seed: "3".repeat(64),
    faults: [
      {
        id: "drop-receipt",
        kind: "receipt-loss",
        action: "send",
        probability: { numerator: 1, denominator: 2 },
      },
    ],
  });
  const result = await runDocument(path, { jar });
  assert.equal(result.outcome, "passed", result.message);
  const events = records(result.trace);
  const stopped = events.find((event) => event.data?.actionId === "stop");
  const unavailable = events.filter(
    (event) => event.kind === "attempt-outcome",
  );
  assert.deepEqual(
    unavailable.map((event) => [
      event.key[0],
      event.runtimeGeneration,
      event.connectionGeneration,
      event.data,
      event.causes,
    ]),
    [
      [
        20,
        null,
        null,
        {
          publication: "report-1",
          attempt: 2,
          outcome: "connection-unavailable",
        },
        [stopped.eventId],
      ],
    ],
  );
  assert.deepEqual(
    events
      .filter((event) => event.kind === "runtime-initialized")
      .map((event) => [event.runtimeGeneration, event.data]),
    [
      [1, { startTimeMs: 0, wallMillis: epoch, monotonicMs: 0, snapshots: [] }],
      [
        2,
        {
          startTimeMs: 50,
          wallMillis: epoch + 50,
          monotonicMs: 0,
          snapshots: [],
        },
      ],
    ],
  );
  // Independent SHA-256 vectors for the two actual draws, excluding the offline attempt.
  assert.deepEqual(
    events
      .filter((event) => event.kind === "fault-decision")
      .map((event) => [
        event.data.attempt,
        event.connectionGeneration,
        event.data.lost,
        event.data.digest,
      ]),
    [
      [
        1,
        1,
        true,
        "43a4db444da5ec9321420453faebd1668b29ff109d65c1e62ae6e848ebb64f26",
      ],
      [
        3,
        2,
        false,
        "d3d7311d1f6c6f7ca4d45eb7523945b4fba7a511784ab91c355a79234c39602b",
      ],
    ],
  );
  const paused = await runDocument(path, {
    jar,
    hostDelay: 3,
    jvmPauseMs: 55,
    paced: true,
    idlePauseMs: 55,
  });
  assert.equal(paused.outcome, "passed", paused.message);
  assert.ok(
    paused.trace === result.trace,
    "host perturbations preserve the complete semantic trace",
  );
  assert.deepEqual(
    paused.diagnostics.generations?.map(
      (generation) => generation.runtimeGeneration,
    ),
    [1, 2],
  );
  const restarted = paused.diagnostics.generations?.[1];
  assert.ok(
    restarted?.node.some(
      (pause) => pause.timeMs === 50 && pause.elapsedNanos > 0,
    ),
  );
  assert.ok(
    restarted?.jvm?.pauses.some(
      (pause) =>
        pause.site === "state-effect" &&
        pause.virtualMs === 50 &&
        pause.elapsedNanos >= 55_000_000,
    ),
  );
});

test("zero-delay offline retries enter later causal rounds and exhaust immediately", async (context) => {
  const result = await run(context, {
    actions: [stop(0), sourceConnect(), send(0)],
    untilMs: 10,
    retries: [{ ...retryPolicy, unavailableRetryIntervalMs: 0 }],
  });
  assert.equal(result.outcome, "assertion-failed", result.message);
  assert.match(result.message ?? "", /retry attempts exhausted/);
  const events = records(result.trace);
  const unavailable = events.filter(
    (event) => event.kind === "attempt-outcome",
  );
  assert.deepEqual(
    unavailable.map((event) => [event.key[0], event.data.attempt]),
    [
      [0, 1],
      [0, 2],
      [0, 3],
    ],
  );
  assert.ok(unavailable[0].key[1] < unavailable[1].key[1]);
  assert.ok(unavailable[1].key[1] < unavailable[2].key[1]);
  assert.equal(
    events.filter((event) => event.kind === "connection-outcome").length,
    1,
  );
  assert.ok(
    !events.some(
      (event) =>
        event.kind === "fault-decision" ||
        event.kind === "receipt" ||
        event.data?.taskKind === "source-receipt-timeout",
    ),
  );
});

test("a managed initial send reconnects after its prepared connection is invalidated", async (context) => {
  const result = await run(context, {
    actions: [sourceConnect(), stop(2, "orderly"), start(5), send(5)],
    untilMs: 35,
    retries: [retryPolicy],
    assertions: [receiptsAt("receipt", 5, [receipt(1, 1)])],
  });
  assert.equal(result.outcome, "passed", result.message);
  const events = records(result.trace);
  const reconnect = events.filter((event) => event.kind === "retry-lifecycle");
  assert.deepEqual(
    reconnect.map((event) => [
      event.key[0],
      event.runtimeGeneration,
      event.connectionGeneration,
      event.data,
    ]),
    [[5, 2, 2, { actionId: "send", operation: "connect", attempt: 1 }]],
  );
  assert.ok(!events.some((event) => event.kind === "attempt-outcome"));
});

test("an abrupt stop retires pending packets, writer handoffs and alarms without fabricating closure", async (context) => {
  const result = await run(context, {
    actions: [
      sourceConnect(),
      clientConnect(),
      action("stall", 0, "writer-stall", client),
      subscribe(0),
      send(0),
      action("late-packet", 6, "source-send", source, {
        publication: "report-2",
      }),
      stop(7),
      start(7),
      clientConnect(7, "new-viewer"),
      subscribe(7, "new-subscription"),
    ],
    untilMs: 40,
    assertions: [
      framesAt("only-new-writer-frames", 40, [ack, frame()]),
      receiptsAt("old-receipt-dropped", 40, []),
    ],
    linkLatencyMs: 5,
  });
  assert.equal(result.outcome, "passed", result.message);
  const events = records(result.trace);
  const stopped = events.find((event) => event.data?.actionId === "stop");
  const cancelled = events.filter(
    (event) => event.kind === "cancelled" && event.parentId === stopped.eventId,
  );
  assert.ok(
    cancelled.some((event) =>
      event.causes.some((cause: string) =>
        events.some(
          (prior) =>
            prior.eventId === cause &&
            prior.data.taskKind === "alarm" &&
            prior.data.atMs === 35,
        ),
      ),
    ),
  );
  const dropped = events.filter(
    (event) => event.kind === "dropped" && event.parentId === stopped.eventId,
  );
  assert.deepEqual(dropped.map((event) => event.data.channel).sort(), [
    "client-frame",
    "source-publication",
    "source-receipt",
  ]);
  assert.ok(
    dropped.every(
      (event) => event.runtimeGeneration === 1 && event.key[0] === 7,
    ),
  );
  assert.ok(
    !events.some(
      (event) =>
        event.kind === "connection-closed" &&
        event.parentId === stopped.eventId,
    ),
  );
  assert.ok(
    !events.some(
      (event) => event.runtimeGeneration === 1 && event.key?.[0] > 7,
    ),
  );
});

test("same-time connect uses declared phase-zero order around stop and start", async (context) => {
  const result = await run(context, {
    actions: [
      clientConnect(),
      stop(5),
      clientConnect(5, "offline"),
      start(5),
      clientConnect(5, "online"),
      subscribe(5),
    ],
    untilMs: 5,
    assertions: [framesAt("online-snapshot", 5, [ack, frame()])],
  });
  assert.equal(result.outcome, "passed", result.message);
  const events = records(result.trace);
  const actions = events
    .filter((event) => event.kind === "action")
    .map((event) => [
      event.data.actionId,
      event.runtimeGeneration,
      event.connectionGeneration,
    ]);
  assert.deepEqual(actions, [
    ["client-connect", 1, 1],
    ["stop", 1, null],
    ["offline", null, null],
    ["start", null, null],
    ["online", 2, 2],
    ["subscribe", 2, 2],
  ]);
  assert.equal(
    events.filter((event) => event.kind === "connection-outcome").length,
    1,
  );
});

test("cumulative frames after restart do not identify a retired connection", async (context) => {
  const result = await run(context, {
    actions: [clientConnect(), subscribe(0), stop(5), start(7)],
    untilMs: 7,
    assertions: [framesAt("retained-frames", 7, [ack, frame()])],
  });
  assert.equal(result.outcome, "passed", result.message);
  const assertion = records(result.trace).find(
    (event) => event.data?.assertionId === "retained-frames",
  );
  assert.deepEqual(
    [assertion.runtimeGeneration, assertion.connectionGeneration],
    [2, null],
  );
});

test("a receipt timeout survives restart as external work without inheriting either generation", async (context) => {
  const result = await run(context, {
    actions: [sourceConnect(), send(10), stop(12), start(15)],
    untilMs: 51,
    // Drop the first in-flight receipt at stop. The reissued publication arrives at 21.
    linkLatencyMs: 1,
    retries: [retryPolicy],
    assertions: [receiptsAt("receipt-after-retry", 50, [receipt(1, 1)])],
  });
  assert.equal(result.outcome, "passed", result.message);
  const events = records(result.trace);
  const timeout = events.find(
    (event) =>
      event.data?.taskKind === "source-receipt-timeout" &&
      event.data?.atMs === 20,
  );
  const dispatch = events.find(
    (event) =>
      event.kind === "task-dispatched" && event.parentId === timeout.eventId,
  );
  assert.deepEqual(
    [
      dispatch.key[0],
      dispatch.runtimeGeneration,
      dispatch.connectionGeneration,
    ],
    [20, null, null],
  );
  assert.deepEqual(
    events
      .filter((event) => event.kind === "retry-attempt")
      .map((event) => [
        event.key[0],
        event.runtimeGeneration,
        event.connectionGeneration,
        event.data.attempt,
      ]),
    [[20, 2, 2, 2]],
  );
});

test("unmanaged downtime attempts send no bytes and require explicit reconnect after restart", async (context) => {
  const result = await run(context, {
    actions: [
      stop(0),
      sourceConnect(1),
      send(2),
      start(5),
      sourceConnect(5, "reconnect"),
      action("manual-retry", 6, "source-retry", source, {
        publication: "report-1",
      }),
    ],
    untilMs: 36,
    assertions: [
      receiptsAt("nothing-sent", 3, []),
      receiptsAt("reapplied", 36, [receipt(1, 1)]),
    ],
  });
  assert.equal(result.outcome, "passed", result.message);
  const events = records(result.trace);
  assert.equal(
    events.filter((event) => event.kind === "connection-outcome").length,
    1,
  );
  const failed = events.filter((event) => event.kind === "attempt-outcome");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].data.attempt, 1);
  const received = events.find((event) => event.kind === "receipt");
  assert.equal(received.runtimeGeneration, 2);
  assert.equal(
    received.connectionGeneration,
    1,
    "failed connect did not allocate an identity",
  );
});
