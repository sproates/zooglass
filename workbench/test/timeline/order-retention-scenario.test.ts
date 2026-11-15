import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildDocument,
  configurationSha256,
  controlReceipts,
  documentWire,
  framesAt,
} from "../../scenarios/timeline-order-retention/author.js";
import {
  attempts,
  controls,
  source,
  views,
} from "../../scenarios/timeline-order-retention/inputs.js";
import {
  receipt,
  snapshot,
} from "../../scenarios/timeline-order-retention/oracle.js";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import { runDocument } from "../../src/timeline/run-document.js";
const directory = resolve("scenarios/timeline-order-retention");
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);

test("authored retention fixture preserves the exact 128-sequence window and explicit sparse boundary oracles", async () => {
  const configuration = await readFile(join(directory, "runtime.json"));
  assert.equal(
    createHash("sha256").update(configuration).digest("hex"),
    configurationSha256,
  );
  assert.equal(JSON.parse(configuration.toString()).identityWindow, 128);
  const document = buildDocument();
  assert.equal(
    await readFile(join(directory, "scenario.json"), "utf8"),
    documentWire(),
  );
  assert.equal(
    parseTimelineDocument(JSON.stringify(document)).profile,
    "sqlite-order-restart-v1",
  );
  assert.equal(document.actors.length, 3);
  assert.equal(
    document.actions.filter((action) => action.kind === "connect").length,
    6,
  );
  assert.equal(
    document.actions.filter((action) => action.kind === "source-retry").length,
    6,
  );
  assert.equal(document.observationTargets.length, 2);
  assert.equal(document.publications.length, 9);
  assert.equal(attempts.length, 15);
  assert.equal(controls.length, 6);
  assert.equal(framesAt(70).length, 24);
  assert.equal(document.assertions.length, 60);
  assert.equal(document.end.pendingFutureTasks, "forbid");
  assert.deepEqual(
    attempts
      .filter((attempt) => attempt.outcome === "committed")
      .map((attempt) => [attempt.publication, attempt.version]),
    [
      ["first", 1],
      ["edge", 3],
      ["lastInWindow", 4],
      ["crossedWindow", 5],
      ["lateGap", 7],
      ["confirmedLate", 8],
    ],
  );
  for (const duplicate of attempts.filter(
    (attempt) => attempt.outcome === "duplicate",
  )) {
    const original = attempts.find(
      (attempt) =>
        attempt.publication === duplicate.publication &&
        attempt.outcome === "committed",
    )!;
    assert.deepEqual(receipt(duplicate), {
      ...receipt(original),
      status: "duplicate",
      reason: "alreadyCommitted",
      changedViews: [],
    });
  }
  assert.deepEqual(
    attempts
      .filter((attempt) => [62, 63, 64].includes(attempt.atMs))
      .map((attempt) => [attempt.publication, attempt.outcome]),
    [
      ["edge", "duplicate"],
      ["first", "outsideRetention"],
      ["expiredGap", "outsideRetention"],
    ],
  );
  assert.deepEqual(controlReceipts(70).at(-1), {
    kind: "watermark",
    stream: { sourceId: "orders", epoch: "run", sourceEntityId: "order-1" },
    throughSequence: 128,
    status: "duplicate",
    reason: "alreadyCommitted",
    version: 6,
    changedViews: [],
  });
  assert.deepEqual(
    snapshot("confirmed", "order-summary").status.inputs.orders.missingRanges,
    [
      { from: 2, through: 2, status: "expired" },
      { from: 4, through: 127, status: "confirmed" },
      { from: 129, through: 129, status: "provisional" },
    ],
  );
  assert.equal(
    snapshot("confirmed", "order-tracking").status.publication,
    "waiting",
  );
  assert.deepEqual(snapshot("confirmed", "order-tracking").data, {});
});

test("prepared runtime preserves publication window, progress and original watermark receipts through restart", async () => {
  const diagnosticDirectory = await mkdtemp(
    join(tmpdir(), "order-retention-positive-"),
  );
  try {
    const run = await runDocument(join(directory, "scenario.json"), {
      jar,
      diagnosticDirectory,
    });
    assert.equal(
      run.outcome,
      "passed",
      run.message ?? "Order retention did not pass",
    );
    const records = run.trace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const initialized = records.filter(
      (record) => record.kind === "runtime-initialized",
    );
    assert.equal(initialized.length, 2);
    assert.deepEqual(
      initialized[1].data.snapshots,
      views.map((view) => snapshot("confirmed", view)),
    );
    assert.equal(initialized[1].data.startTimeMs, 60);
    assert.equal(records.at(-1).pendingFutureTasks, 0);
    assert.equal(records.at(-1).pendingMessages, 0);
    assert.equal(records.at(-1).heldFrames, 0);
  } finally {
    await rm(diagnosticDirectory, { recursive: true, force: true });
  }
});

test("retention oracles reject count-based floors, an evicted inclusive edge and ignored confirmed-late violations", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "order-retention-negative-"));
  try {
    await writeFile(
      join(temporary, "runtime.json"),
      await readFile(join(directory, "runtime.json")),
    );
    const original = buildDocument();
    const wrongFloor = structuredClone(
      snapshot("crossedWindow", "order-summary"),
    );
    wrongFloor.status.inputs.orders.admissionFloor = 1;
    wrongFloor.status.inputs.orders.missingRanges[0].status = "provisional";
    const wrongEdge = attempts
      .filter((attempt) => attempt.atMs <= 43)
      .map(receipt);
    wrongEdge[wrongEdge.length - 1] = {
      ...wrongEdge.at(-1)!,
      status: "rejected",
      reason: "outsideRetention",
      version: 5,
      targets: [],
    };
    const wrongViolation = structuredClone(
      snapshot("violated", "order-summary"),
    );
    wrongViolation.status.inputs.orders.sourceContractViolated = false;
    wrongViolation.status.inputs.orders.completeness = "incomplete";
    const cases = [
      {
        id: "window-is-sequence-span-not-receipt-count",
        atMs: 40,
        kind: "runtime-snapshot",
        viewId: "order-summary",
        entityId: "order-1",
        expected: { outcome: "available", snapshot: wrongFloor },
      },
      {
        id: "inclusive-floor-identity-remains-retained",
        atMs: 43,
        kind: "source-receipts",
        actor: source,
        expected: wrongEdge,
      },
      {
        id: "new-confirmed-late-input-must-violate",
        atMs: 66,
        kind: "runtime-snapshot",
        viewId: "order-summary",
        entityId: "order-1",
        expected: { outcome: "available", snapshot: wrongViolation },
      },
    ];
    for (const wrong of cases) {
      const document = { ...original, assertions: [wrong] };
      assert.doesNotThrow(() =>
        parseTimelineDocument(JSON.stringify(document)),
      );
      const path = join(temporary, `${wrong.id}.json`);
      await writeFile(path, JSON.stringify(document));
      const run = await runDocument(path, {
        jar,
        diagnosticDirectory: temporary,
      });
      assert.equal(run.outcome, "assertion-failed");
      assert.equal(run.message, `assertion-failed: ${wrong.id}`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
