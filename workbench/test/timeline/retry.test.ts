import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  fixture,
  files,
  ack,
  frame,
  receipt,
  epoch,
  source,
} from "./document-fixture.js";
import { runDocument } from "../../src/timeline/run-document.js";
import { replayDocument } from "../../src/timeline/replay-document.js";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ?? "../zooglass/target/zooglass.jar",
);
function managed(lost = false) {
  const f = fixture();
  const document = {
    ...f.document,
    retries: [
      {
        action: "send-1",
        maxAttempts: 3,
        receiptTimeoutMs: 5,
        retryIntervalMs: 2,
      },
    ],
    faults: lost
      ? [
          {
            id: "lose-first",
            kind: "receipt-loss",
            action: "send-1",
            probability: { numerator: 1, denominator: 2 },
          },
        ]
      : [],
  };
  document.seed = "2".repeat(64);
  document.actions = document.actions.slice(0, 4);
  document.untilMs = 60;
  document.assertions.find((a) => a.id === "all-frames")!.atMs = 60;
  document.assertions.find((a) => a.id === "all-frames")!.expected = [
    ack,
    frame(),
    frame(1, 1, "fresh", epoch + 10),
    frame(2, 1, "stale", epoch + 10),
  ];
  document.assertions.find((a) => a.id === "receipts")!.atMs = 60;
  document.assertions.find((a) => a.id === "receipts")!.expected = [
    receipt(1, 1, lost),
  ];
  return { configuration: f.configuration, document };
}
const records = (trace: string) =>
  trace
    .trimEnd()
    .split("\n")
    .map((s) => JSON.parse(s));

test("managed retry recovers two lost receipts on fresh generations without reapplying or refreshing the commit", async () => {
  const input = await files(managed(true));
  try {
    const run = await runDocument(input.path, { jar });
    assert.equal(run.outcome, "passed", run.message);
    const trace = records(run.trace);
    assert.deepEqual(
      trace
        .filter((e) => e.kind === "retry-attempt")
        .map((e) => [e.key[0], e.data.attempt, e.connectionGeneration]),
      [
        [17, 2, 2],
        [24, 3, 3],
      ],
    );
    assert.deepEqual(
      trace
        .filter((e) => e.kind === "fault-decision")
        .map((e) => [e.data.attempt, e.data.lost]),
      [
        [1, true],
        [2, true],
        [3, false],
      ],
    );
    const acknowledged = trace.filter(
      (e) => e.kind === "retry-status" && e.data.status === "acknowledged",
    );
    assert.equal(acknowledged.length, 1);
    assert.equal(acknowledged[0].connectionGeneration, 3);
    assert.equal(trace.filter((e) => e.kind === "state").length, 2); // commit then real expiry only
    const path = input.path + ".run.json";
    await writeFile(path, JSON.stringify(run));
    const replay = await replayDocument(path, {
      jar,
      hostDelay: 1,
      paced: true,
      idlePauseMs: 60,
    });
    assert.equal(replay.status, "verified");
    assert.equal(replay.actual.trace, run.trace);
  } finally {
    await input.close();
  }
});

test("receipt cancels its timeout with scheduling provenance and no extra generation", async () => {
  const input = await files(managed());
  try {
    const run = await runDocument(input.path, { jar });
    assert.equal(run.outcome, "passed", run.message);
    const trace = records(run.trace);
    const timer = trace.find(
      (e) =>
        e.kind === "scheduled" && e.data.taskKind === "source-receipt-timeout",
    );
    const cancelled = trace.find(
      (e) => e.kind === "cancelled" && e.data.taskId === timer.data.taskId,
    );
    assert.deepEqual(cancelled.causes, [timer.eventId]);
    assert.ok(!trace.some((e) => e.kind === "retry-attempt"));
    assert.equal(trace.at(-1).pendingFutureTasks, 0);
  } finally {
    await input.close();
  }
});

test("nonfinal zero-timeout tie cancels queued retry at zero or positive interval without consuming an attempt", async () => {
  for (const interval of [0, 10]) {
    const f = managed();
    f.document.retries[0].receiptTimeoutMs = 0;
    f.document.retries[0].retryIntervalMs = interval;
    const input = await files(f);
    try {
      const run = await runDocument(input.path, { jar });
      assert.equal(run.outcome, "passed", run.message);
      const trace = records(run.trace);
      const timeout = trace.find(
        (e) => e.kind === "retry-status" && e.data.status === "timed-out",
      );
      const receiptEvent = trace.find(
        (e) => e.kind === "delivered" && e.data.channel === "source-receipt",
      );
      assert.deepEqual(timeout.key.slice(0, 3), [10, 1, 1]);
      assert.deepEqual(receiptEvent.key.slice(0, 3), [10, 1, 2]);
      const retry = trace.find(
        (e) => e.kind === "scheduled" && e.data.taskKind === "source-retry",
      );
      assert.equal(retry.data.atMs, 10 + interval);
      assert.ok(
        trace.some(
          (e) => e.kind === "cancelled" && e.data.taskId === retry.data.taskId,
        ),
      );
      assert.ok(
        !trace.some(
          (e) => e.kind === "retry-lifecycle" || e.kind === "retry-attempt",
        ),
      );
    } finally {
      await input.close();
    }
  }
});

test("final timeout and all-loss exhaustion are replayable scenario failures", async () => {
  for (const finalTie of [true, false]) {
    const f = managed(!finalTie);
    if (finalTie) {
      f.document.retries[0].maxAttempts = 1;
      f.document.retries[0].receiptTimeoutMs = 0;
    } else f.document.faults[0].probability = { numerator: 1, denominator: 1 };
    const input = await files(f);
    try {
      const run = await runDocument(input.path, { jar });
      assert.equal(run.outcome, "assertion-failed", run.message);
      assert.match(run.message!, /attempts exhausted/);
      const trace = records(run.trace);
      assert.equal(
        trace.filter((e) => e.kind === "retry-attempt").length,
        finalTie ? 0 : 2,
      );
      assert.equal(
        trace.find(
          (e) => e.kind === "retry-status" && e.data.status === "exhausted",
        ).key[0],
        finalTie ? 10 : 29,
      );
      const path = input.path + ".run.json";
      await writeFile(path, JSON.stringify(run));
      const replay = await replayDocument(path, { jar });
      assert.equal(replay.status, "verified");
      assert.equal(replay.recordedOutcome, "assertion-failed");
    } finally {
      await input.close();
    }
  }
});

test("unfinished actor at horizon fails even when future tasks are allowed and retains both timer counts", async () => {
  const f = managed(true);
  f.document.untilMs = 12;
  f.document.assertions = [];
  f.document.end.pendingFutureTasks = "allow";
  const input = await files(f);
  try {
    const run = await runDocument(input.path, { jar });
    assert.equal(run.outcome, "assertion-failed", run.message);
    assert.match(run.message!, /unfinished retry actor/);
    assert.equal(records(run.trace).at(-1).pendingFutureTasks, 2); // real freshness + actor receipt timeout
  } finally {
    await input.close();
  }
});

test("unrelated source receipt does not acknowledge the managed publication", async () => {
  const f = managed(true);
  f.document.actors.push({ id: "other", role: "source" });
  f.document.links.push({ actor: "other", latencyMs: 0 });
  f.document.actions.push(
    { id: "other-connect", kind: "connect", actor: "other", atMs: 0 },
    {
      id: "other-send",
      kind: "source-send",
      actor: "other",
      atMs: 11,
      publication: "report-1",
    },
  );
  f.document.assertions.push({
    id: "other-receipt",
    kind: "source-receipts",
    actor: "other",
    atMs: 60,
    expected: [receipt(1, 1, true)],
  });
  const input = await files(f);
  try {
    const run = await runDocument(input.path, { jar });
    assert.equal(run.outcome, "passed", run.message);
    const acknowledgements = records(run.trace).filter(
      (e) => e.kind === "retry-status" && e.data.status === "acknowledged",
    );
    assert.deepEqual(
      acknowledgements.map((e) => [e.actor, e.key[0]]),
      [[source, 24]],
    );
  } finally {
    await input.close();
  }
});

test("managed sources reject competing controls and reserve maximum connection generations before Java startup", async () => {
  for (const change of ["manual", "duplicate", "target", "bounds"]) {
    const f = managed();
    f.document.runtime.sha256 = "0".repeat(64);
    if (change === "manual")
      f.document.actions.push({
        id: "manual-disconnect",
        kind: "disconnect",
        actor: source,
        atMs: 40,
      });
    if (change === "duplicate")
      f.document.retries.push({ ...f.document.retries[0] });
    if (change === "target") f.document.retries[0].action = "subscribe";
    if (change === "bounds") f.document.retries[0].maxAttempts = 11;
    assert.throws(() => parseTimelineDocument(JSON.stringify(f.document)));
  }
  const f = managed();
  f.document.retries[0].maxAttempts = 10;
  const input = await files(f);
  try {
    await assert.rejects(
      runDocument(input.path, { jar: "/missing.jar" }),
      /at most ten connection generations/,
    );
  } finally {
    await input.close();
  }
});

test("a delivered rejection acknowledges transport without asserting publication acceptance", async () => {
  const f = managed();
  (f.document.publications[0] as { body: unknown }).body = {};
  for (const assertion of f.document.assertions)
    assertion.expected =
      assertion.kind === "client-frames"
        ? [ack, frame()]
        : [
            {
              status: "rejected",
              reason: "invalidEnvelope",
              stream: null,
              publicationSequence: null,
              version: null,
              changedViews: [],
              targets: [],
            },
          ];
  const input = await files(f);
  try {
    const run = await runDocument(input.path, { jar });
    assert.equal(run.outcome, "passed", run.message);
    const trace = records(run.trace);
    assert.ok(
      trace.some(
        (e) => e.kind === "retry-status" && e.data.status === "acknowledged",
      ),
    );
    assert.ok(
      !trace.some((e) => e.kind === "retry-attempt" || e.kind === "state"),
    );
  } finally {
    await input.close();
  }
});
