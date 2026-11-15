import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { checkSqliteCampaignRun } from "../../scripts/sqlite-campaign-checks.js";
import { sqliteCampaignInputs } from "../../scripts/sqlite-campaign-inputs.js";
import { canonicalJson } from "../../src/timeline/json.js";
import { runDocument } from "../../src/timeline/run-document.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
const unpaused = { hostDelay: 0, jvmPauseMs: 0, paced: false, idlePauseMs: 0 };

test("the SQLite oracle independently checks full durable receipts, offline attempts and real pauses", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "sqlite-campaign-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const {
    groups: [durable],
  } = await sqliteCampaignInputs(directory);
  const result = await runDocument(durable.path, {
    jar,
    diagnosticDirectory: directory,
  });
  const raw = JSON.stringify(result);
  assert.equal(
    checkSqliteCampaignRun(raw, undefined, unpaused, durable.expected).outcome,
    "passed",
  );

  function changedTrace(
    change: (events: ReturnType<typeof JSON.parse>[]) => void,
  ) {
    const events = result.trace
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    change(events);
    return JSON.stringify({
      ...result,
      trace:
        events.map((line) => canonicalJson(JSON.stringify(line))).join("\n") +
        "\n",
    });
  }

  const corruptedReceipt = changedTrace((events) => {
    const original = events.find(
      (event) => event.kind === "receipt" && event.runtimeGeneration === 1,
    );
    original.data.envelope.targets[0].entityId = "different-entity";
  });
  assert.throws(
    () =>
      checkSqliteCampaignRun(
        corruptedReceipt,
        undefined,
        unpaused,
        durable.expected,
      ),
    /complete original and duplicate durable receipts/,
  );

  const fabricatedTimer = changedTrace((events) => {
    const outcome = events.findIndex(
      (event) => event.kind === "attempt-outcome",
    );
    const unavailable = events[outcome];
    const scheduled = {
      ...unavailable,
      eventId: "unavailable-timeout",
      kind: "scheduled",
      parentId: unavailable.eventId,
      data: {
        atMs: 30,
        phase: 1,
        taskId: "-1000",
        taskKind: "source-receipt-timeout",
      },
    };
    delete scheduled.causes;
    const cancelled = {
      ...scheduled,
      eventId: "cancel-unavailable-timeout",
      kind: "cancelled",
      causes: [scheduled.eventId],
      data: { taskId: "-1000" },
    };
    events.splice(outcome + 1, 0, scheduled, cancelled);
    events.at(-1).eventCount += 2;
  });
  assert.throws(
    () =>
      checkSqliteCampaignRun(
        fabricatedTimer,
        undefined,
        unpaused,
        durable.expected,
      ),
    /independent retry timer schedule/,
  );

  const mode = { hostDelay: 55, jvmPauseMs: 55, paced: true, idlePauseMs: 55 };
  const paused = await runDocument(durable.path, {
    jar,
    ...mode,
    diagnosticDirectory: directory,
  });
  checkSqliteCampaignRun(
    JSON.stringify(paused),
    result,
    mode,
    durable.expected,
  );
  paused.diagnostics.generations![1].jvm!.pauses[0].elapsedNanos = 1;
  assert.throws(
    () =>
      checkSqliteCampaignRun(
        JSON.stringify(paused),
        result,
        mode,
        durable.expected,
      ),
    /measured JVM pause duration/,
  );
});
