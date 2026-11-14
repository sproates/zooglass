import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  recordBundle,
  replayBundle,
} from "../../src/timeline/artifact-bundle.js";
import { canonicalJson } from "../../src/timeline/json.js";
import { parseReplay } from "../../src/timeline/replay-document.js";
import { runDocument } from "../../src/timeline/run-document.js";
import { RuntimeGenerations } from "../../src/timeline/runtime-generations.js";
import { parseTrace } from "../../src/timeline/trace-contract.js";
import {
  action,
  client,
  epoch,
  files,
  fixture,
  receipt,
  source,
} from "./document-fixture.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);

function lifecycleInput() {
  const input = fixture();
  input.document.format = "timeline-simulation/v2";
  input.document.actions = [
    action("connect", 0, "connect", source),
    action("send", 10, "source-send", source, { publication: "report-1" }),
    { id: "stop", atMs: 11, kind: "service-stop", mode: "abrupt" },
    action("unavailable", 20, "connect", client),
    { id: "start", atMs: 50, kind: "service-start" },
    action("reconnect", 50, "connect", source),
    action("retry", 50, "source-retry", source, { publication: "report-1" }),
  ];
  input.document.assertions = [
    {
      id: "during-stop",
      atMs: 25,
      kind: "source-receipts",
      actor: source,
      expected: [receipt(1, 1)],
    },
    {
      id: "after-restart",
      atMs: 100,
      kind: "source-receipts",
      actor: source,
      expected: [receipt(1, 1), receipt(1, 1)],
    },
  ];
  return input;
}

test("v2 bundle retains restart evidence and rejects altered generation or version identities", async () => {
  const input = await files(lifecycleInput());
  const root = await mkdtemp(join(tmpdir(), "timeline-lifecycle-evidence-"));
  const directory = join(root, "bundle");
  try {
    const run = await recordBundle(input.path, directory, { jar });
    assert.equal(run.outcome, "passed", run.message);
    assert.equal(run.format, "timeline-run/v2");
    assert.equal(run.execution.profile, "receipt-age-restart-v1");
    assert.equal(parseTrace(run.trace).header.format, "timeline-trace/v2");

    const manifestPath = join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.format, "timeline-bundle/v2");
    assert.deepEqual(manifest.versions, {
      scenario: "timeline-simulation/v2",
      trace: "timeline-trace/v2",
      scheduler: "time-round-phase-ordinal/v1",
      randomness: "sha256-length-prefixed/v1",
      protocol: 2,
    });

    await input.close();
    const replay = await replayBundle(directory, { jar, jvmPauseMs: 70 });
    assert.equal(replay.status, "verified");
    assert.equal(replay.actual.trace, run.trace);

    const events = run.trace
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const starts = events.filter(
      (record) => record.kind === "runtime-initialized",
    );
    assert.deepEqual(
      starts.map((record) => [record.runtimeGeneration, record.data]),
      [
        [
          1,
          { startTimeMs: 0, wallMillis: epoch, monotonicMs: 0, snapshots: [] },
        ],
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

    assert.throws(
      () => parseReplay(JSON.stringify({ ...run, format: "timeline-run/v1" })),
      /run\/scenario version mismatch/,
    );
    const changedClock = structuredClone(events);
    changedClock.find(
      (record) =>
        record.kind === "runtime-initialized" && record.runtimeGeneration === 2,
    ).data.wallMillis++;
    assert.throws(
      () =>
        parseReplay(
          JSON.stringify({ ...run, trace: encodedTrace(changedClock) }),
        ),
      /wall clock must equal epoch/,
    );

    const staleDispatch = structuredClone(events);
    const dispatch = staleDispatch.find(
      (record) =>
        record.kind === "task-dispatched" && record.runtimeGeneration === 2,
    );
    dispatch.runtimeGeneration = 1;
    assert.throws(
      () => parseTrace(encodedTrace(staleDispatch)),
      /generation does not match availability/,
    );

    const staleConnection = structuredClone(events);
    const observation = staleConnection.find(
      (record) => record.data?.assertionId === "after-restart",
    );
    assert.equal(observation.runtimeGeneration, 2);
    assert.equal(observation.connectionGeneration, 2);
    observation.connectionGeneration = 1;
    assert.throws(
      () =>
        parseReplay(
          JSON.stringify({ ...run, trace: encodedTrace(staleConnection) }),
        ),
      /connection identity does not belong to this runtime generation/,
    );

    const reusedConnection = structuredClone(events);
    reusedConnection.find(
      (record) => record.data?.actionId === "reconnect",
    ).connectionGeneration = 1;
    assert.throws(
      () => parseTrace(encodedTrace(reusedConnection)),
      /connect must introduce the actor's next connection generation/,
    );

    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        format: "timeline-bundle/v1",
        versions: {
          ...manifest.versions,
          scenario: "timeline-simulation/v1",
          trace: "timeline-trace/v1",
          protocol: 1,
        },
      }),
    );
    await assert.rejects(
      replayBundle(directory, { jar: "/missing.jar" }),
      /manifest\/run version mismatch/,
    );
  } finally {
    await input.close();
    await rm(root, { recursive: true, force: true });
  }
});

function encodedTrace(events: unknown[]) {
  return events
    .map((event) => canonicalJson(JSON.stringify(event)) + "\n")
    .join("");
}

test("a failed v2 run retains exhausted downtime attempts with global timer causality", async () => {
  const input = fixture();
  input.document.format = "timeline-simulation/v2";
  input.document.actions = [
    action("connect", 0, "connect", source),
    { id: "stop", atMs: 5, kind: "service-stop", mode: "orderly" },
    action("send", 10, "source-send", source, { publication: "report-1" }),
  ];
  input.document.assertions = [];
  const saved = await files(input, (document) =>
    JSON.stringify({
      ...JSON.parse(document),
      retries: [
        {
          action: "send",
          maxAttempts: 3,
          receiptTimeoutMs: 10,
          retryIntervalMs: 0,
          unavailableRetryIntervalMs: 0,
        },
      ],
    }),
  );
  try {
    const run = await runDocument(saved.path, { jar });
    assert.equal(run.outcome, "assertion-failed", run.message);
    assert.match(run.message ?? "", /retry attempts exhausted/);
    assert.equal(parseReplay(JSON.stringify(run)).outcome, "assertion-failed");

    const records = run.trace
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const attempts = records.filter(
      (record) => record.kind === "attempt-outcome",
    );
    assert.deepEqual(
      attempts.map((record) => [
        record.key[0],
        record.data.attempt,
        record.runtimeGeneration,
        record.connectionGeneration,
      ]),
      [
        [10, 1, null, null],
        [10, 2, null, null],
        [10, 3, null, null],
      ],
    );
    assert.ok(
      attempts[0].key[1] < attempts[1].key[1] &&
        attempts[1].key[1] < attempts[2].key[1],
    );
    const stop = records.find(
      (record) => record.data?.actionKind === "service-stop",
    );
    for (const attempt of attempts)
      assert.deepEqual(attempt.causes, [stop.eventId]);

    // Keep the reference structurally valid, but remove the causal link to downtime.
    attempts[1].causes = [attempts[0].eventId];
    assert.throws(
      () => parseTrace(encodedTrace(records)),
      /current stop cause/,
    );
  } finally {
    await saved.close();
  }
});

test("v2 replay rejects a frame with an omitted connection identity", async () => {
  const run = await runDocument("scenarios/simulation/memory-restart.json", {
    jar,
  });
  assert.equal(run.outcome, "passed", run.message);
  const records = run.trace
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const frame = records.find((record) => record.kind === "frame");
  assert.ok(frame?.connectionGeneration);
  frame.connectionGeneration = null;

  assert.throws(
    () => parseReplay(JSON.stringify({ ...run, trace: encodedTrace(records) })),
    /session-bound event requires a connection identity/,
  );
});

test("v2 cleanup failure retains the original assertion and live prefix", async (context) => {
  const input = lifecycleInput();
  input.document.assertions[1].expected = [];
  const saved = await files(input);
  const close = RuntimeGenerations.prototype.close;
  context.mock.method(
    RuntimeGenerations.prototype,
    "close",
    async function (this: RuntimeGenerations) {
      await close.call(this);
      throw new Error("injected host cleanup failure");
    },
  );
  try {
    const run = await runDocument(saved.path, { jar });
    assert.equal(run.outcome, "infrastructure-failed");
    assert.match(run.message ?? "", /assertion-failed: after-restart/);
    assert.match(run.message ?? "", /injected host cleanup failure/);
    const last = JSON.parse(run.trace.trimEnd().split("\n").at(-1)!);
    assert.equal(last.kind, "assertion");
    assert.equal(last.data.assertionId, "after-restart");
    assert.equal(last.data.passed, false);
    assert.throws(() => parseReplay(JSON.stringify(run)));
  } finally {
    await saved.close();
  }
});
