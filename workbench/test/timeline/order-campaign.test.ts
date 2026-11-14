import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  checkOrderCampaignRun,
  orderCounts,
} from "../../scripts/order-campaign-checks.js";
import type { DocumentRun } from "../../src/timeline/campaign-checks.js";
import { canonicalJson } from "../../src/timeline/json.js";
import { runDocument } from "../../src/timeline/run-document.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
const baselineMode = {
  hostDelay: 0,
  jvmPauseMs: 0,
  paced: false,
  idlePauseMs: 0,
};
const paths = {
  ordinary: "timeline-order/scenario.json",
  before: "timeline-order-recovery/before.json",
  at: "timeline-order-recovery/at.json",
  after: "timeline-order-recovery/after.json",
  retention: "timeline-order-retention/scenario.json",
};
const traceRows = (run: DocumentRun) =>
  run.trace
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
function changedTrace(
  run: DocumentRun,
  mutate: (rows: ReturnType<typeof traceRows>) => void,
) {
  const rows = traceRows(run);
  mutate(rows);
  return JSON.stringify({
    ...run,
    trace:
      rows.map((row) => canonicalJson(JSON.stringify(row))).join("\n") + "\n",
  });
}

test("Order campaign checks every authored group and independently rejects altered complete evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "order-campaign-check-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const expected of orderCounts) {
    const run = await runDocument(resolve("scenarios", paths[expected.group]), {
      jar,
      diagnosticDirectory: directory,
    });
    const check = (raw: string, baseline?: DocumentRun) =>
      checkOrderCampaignRun(raw, baseline, baselineMode, expected);
    assert.equal(check(JSON.stringify(run)).outcome, "passed");
    assert.throws(
      () => check(JSON.stringify({ ...run, outcome: "assertion-failed" })),
      /scenario failed/,
    );
    assert.throws(
      () =>
        checkOrderCampaignRun(JSON.stringify(run), undefined, baselineMode, {
          ...expected,
          records: expected.records - 1,
        }),
      /complete Order record count/,
    );
    assert.throws(
      () =>
        check(
          changedTrace(run, (rows) => {
            const receipt = rows.find((row) => row.kind === "receipt");
            receipt.data.envelope.targets[0].reason = "inventedDisposition";
          }),
        ),
      /complete authored source-receipts/,
    );
    assert.throws(
      () =>
        check(
          changedTrace(run, (rows) => {
            const assertion = rows.find(
              (row) =>
                row.kind === "assertion" &&
                row.data.assertionKind === "runtime-snapshot",
            );
            assertion.data.actual.snapshot.version = 999;
          }),
          run,
        ),
      /semantic trace divergence at record/,
    );
    if (expected.group !== "ordinary")
      assert.throws(
        () =>
          check(
            changedTrace(run, (rows) => {
              const restart = rows.find(
                (row) =>
                  row.kind === "runtime-initialized" &&
                  row.runtimeGeneration === 2,
              );
              restart.data.snapshots[0].version = 999;
            }),
          ),
        /independent installed Order recovery/,
      );
  }
});

test("Order campaign requires actual long pauses in every runtime generation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "order-campaign-pauses-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expected = orderCounts.find((row) => row.group === "retention")!;
  const path = resolve("scenarios", paths.retention);
  const baseline = await runDocument(path, {
    jar,
    diagnosticDirectory: directory,
  });
  const mode = { hostDelay: 70, jvmPauseMs: 90, paced: true, idlePauseMs: 70 };
  const paused = await runDocument(path, {
    jar,
    ...mode,
    diagnosticDirectory: directory,
  });
  const check = (run: DocumentRun) =>
    checkOrderCampaignRun(JSON.stringify(run), baseline, mode, expected);
  assert.equal(check(paused).outcome, "passed");
  assert.throws(
    () =>
      checkOrderCampaignRun(JSON.stringify(paused), baseline, mode, {
        ...expected,
        generations: [
          { ...expected.generations[0], alarm: 10 },
          expected.generations[1],
        ],
      }),
    /actual JVM state and writer pauses/,
  );
  const mutate = (change: (run: DocumentRun) => void, message: RegExp) => {
    const run = structuredClone(paused);
    change(run);
    assert.throws(() => check(run), message);
  };
  mutate((run) => {
    run.diagnostics.generations!.pop();
  }, /complete timing generations/);
  mutate((run) => {
    run.diagnostics.generations![1].jvm!.pauses = [];
  }, /actual JVM state and writer pauses/);
  mutate((run) => {
    run.diagnostics.generations![1].jvm!.pauses[0].virtualMs++;
  }, /actual JVM state and writer pauses/);
  mutate((run) => {
    run.diagnostics.generations![1].jvm!.pauses[0].elapsedNanos = 1;
  }, /measured JVM pause too short/);
  mutate((run) => {
    run.diagnostics.generations![1].node.pop();
  }, /complete Node command pauses/);
  mutate((run) => {
    run.diagnostics.generations![0].node[0].elapsedNanos = 1;
  }, /measured Node pause too short/);
  mutate((run) => {
    run.diagnostics.generations![1].node[0].turn = 0;
  }, /continuous command identities/);
  mutate((run) => {
    run.diagnostics.generations![1].node[0].timeMs = 0;
  }, /actual generation initialization pause/);
  mutate((run) => {
    run.diagnostics.generations![1].node.forEach((pause) => {
      if (pause.operation === "progress") pause.operation = "observe";
    });
  }, /missing Node progress pause/);
});

test("Order campaign counts cancelled requests separately from orderly shutdown commands", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "order-campaign-orderly-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expected = orderCounts.find((row) => row.group === "before")!;
  const path = resolve("scenarios", paths.before);
  const baseline = await runDocument(path, {
    jar,
    diagnosticDirectory: directory,
  });
  const mode = { hostDelay: 70, jvmPauseMs: 90, paced: true, idlePauseMs: 70 };
  const paused = await runDocument(path, {
    jar,
    ...mode,
    diagnosticDirectory: directory,
  });
  assert.equal(
    checkOrderCampaignRun(JSON.stringify(paused), baseline, mode, expected)
      .outcome,
    "passed",
  );
  const [first, second] = paused.diagnostics.generations!;
  assert.deepEqual(
    first.node
      .filter((pause) => pause.operation === "progress")
      .map((pause) => pause.timeMs),
    [40],
  );
  const shutdown = first.node.at(-1)!;
  assert.deepEqual(
    [shutdown.operation, shutdown.timeMs, shutdown.turn],
    ["shutdown", 48, 145],
  );
  assert.deepEqual(
    [first.node.length, second.node.length, second.node[0].turn],
    [146, 62, 146],
  );
  const rows = traceRows(paused);
  const action = rows.find(
    (row) => row.kind === "action" && row.data.actionId === "original-B",
  );
  const send = rows.find(
    (row) => row.kind === "link-send" && row.parentId === action.eventId,
  );
  assert.deepEqual(
    [action.key[0], send.data.channel, send.data.deliverAtMs],
    [45, "progress-request", 55],
  );
  const drop = rows.find(
    (row) =>
      row.kind === "dropped" && row.data.messageId === send.data.messageId,
  );
  const stop = rows.find((row) => row.eventId === drop.parentId);
  assert.deepEqual(
    [
      drop.key[0],
      drop.causes,
      drop.data.reason,
      stop.data.actionKind,
      stop.data.mode,
    ],
    [48, [send.eventId], "connection-closed", "service-stop", "orderly"],
  );
  assert.equal(
    rows.some(
      (row) =>
        row.kind === "delivered" && row.data.messageId === send.data.messageId,
    ),
    false,
  );
  assert.throws(
    () =>
      checkOrderCampaignRun(JSON.stringify(paused), baseline, mode, {
        ...expected,
        generations: [
          { ...expected.generations[0], commands: 147 },
          expected.generations[1],
        ],
      }),
    /complete Node command pauses/,
  );
});
