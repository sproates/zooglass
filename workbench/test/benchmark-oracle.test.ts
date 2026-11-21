import assert from "node:assert/strict";
import test from "node:test";
import { BenchmarkOracle } from "../src/benchmark/oracle.js";
import {
  BenchmarkLimit,
  type BenchmarkPublication,
  type OracleOptions,
} from "../src/benchmark/model.js";

const views = ["view-0", "view-1"];
const viewers = ["viewer-0", "viewer-1"];
function oracle(options: Partial<OracleOptions> = {}) {
  return new BenchmarkOracle({
    storage: "memory",
    viewIds: views,
    viewerIds: viewers,
    ...options,
  });
}
function publication(sequence = 1): BenchmarkPublication {
  return {
    sourceId: "benchmark",
    epoch: "run",
    sourceEntityId: "entity-0",
    publicationSequence: sequence,
    type: "value",
    payload: { marker: `0:${sequence}`, padding: "xx" },
  };
}
const source = {
  sourceId: "benchmark",
  epoch: "run",
  sourceEntityId: "entity-0",
};
function receipt(sequence = 1, version = 71) {
  return {
    status: "applied",
    reason: "memory",
    stream: source,
    publicationSequence: sequence,
    version,
    changedViews: views,
    targets: views.map((viewId) => ({
      viewId,
      entityId: "entity-0",
      status: "accepted",
      reason: null,
      changedFields: ["value"],
      fields: [
        { field: "value", status: "accepted", reason: null, changed: true },
      ],
    })),
  };
}
function frame(viewId: string, sequence = 1, version = 71) {
  return {
    type: "view-update",
    viewId,
    entityId: "entity-0",
    version,
    provenance: { value: source },
    publicationSequences: { value: [sequence] },
    data: { value: { marker: `0:${sequence}`, padding: "xx" } },
  };
}

test("measure ACK and last required delivery independently across phase boundaries", () => {
  const subject = oracle();
  subject.register(publication(1), {
    phase: "seed",
    plannedMs: 0,
    submittedMs: 0,
  });
  subject.recordReceipt(receipt(1, 39), 0.5);
  subject.register(publication(2), {
    phase: "warmup",
    plannedMs: 1,
    submittedMs: 1.25,
  });
  subject.register(publication(3), {
    phase: "measurement",
    plannedMs: 2,
    submittedMs: 2.125,
  });
  for (const viewer of viewers) {
    for (const view of views) {
      subject.recordUpdate(viewer, frame(view, 2, 40), 3);
    }
  }
  assert.equal(subject.summary().phases.warmup.completedFanout, 1);
  assert.equal(subject.summary().phases.warmup.missingReceipts, 1);
  subject.recordReceipt(receipt(2, 40), 4);
  subject.recordReceipt(receipt(3, 50), 5);
  for (const viewer of viewers) {
    for (const view of views) {
      if (viewer === "viewer-1" && view === "view-1") {
        continue;
      }
      subject.recordUpdate(viewer, frame(view, 3, 50), 6);
    }
  }
  assert.deepEqual(subject.summary().phases.measurement, {
    submitted: 1,
    acknowledged: 1,
    expectedUpdates: 4,
    validUpdates: 3,
    completedFanout: 0,
    missingReceipts: 0,
    missingUpdates: 1,
    pendingFanout: 1,
  });
  assert.equal(subject.pendingCount, 1);
  subject.recordUpdate("viewer-1", frame("view-1", 3, 50), 7);
  assert.equal(subject.pendingCount, 0);
  assert.equal(subject.summary().phases.seed.expectedUpdates, 0);
  const raw = Buffer.concat([...subject.rawChunks()]);
  const rows = raw
    .toString()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(raw.byteLength, subject.summary().encodedBytes);
  assert.equal(rows.length, subject.summary().rawEntries);
  assert.deepEqual(rows.at(-1), {
    kind: "update",
    phase: "measurement",
    entityId: "entity-0",
    sequence: 3,
    atMs: 7,
    viewerId: "viewer-1",
    viewId: "view-1",
    version: 50,
  });
  assert.equal(
    rows.find((row) => row.kind === "receipt" && row.sequence === 2).phase,
    "warmup",
  );
  assert.equal(
    rows.find((row) => row.kind === "submit" && row.sequence === 3).plannedMs,
    2,
  );
});

test("wrong or missing receipts cannot pay a submitted publication's obligation", () => {
  for (const [bad, fault] of [
    [
      { ...receipt(), stream: { ...source, epoch: "prior" } },
      "unexpected-receipt",
    ],
    [{ ...receipt(), publicationSequence: 99 }, "unexpected-receipt"],
    [
      { ...receipt(), reason: "sqlite", status: "committed" },
      "mismatched-receipt",
    ],
    [{ ...receipt(), version: 0 }, "mismatched-receipt"],
    [
      { ...receipt(), targets: receipt().targets.slice(1) },
      "mismatched-receipt",
    ],
    [{ ...receipt(), changedViews: [] }, "mismatched-receipt"],
    [
      {
        ...receipt(),
        targets: receipt().targets.map((target) => ({
          ...target,
          changedFields: [],
        })),
      },
      "mismatched-receipt",
    ],
    [
      {
        ...receipt(),
        targets: receipt().targets.map((target) => ({
          ...target,
          fields: [
            {
              field: "value",
              status: "accepted",
              reason: null,
              changed: false,
            },
          ],
        })),
      },
      "mismatched-receipt",
    ],
    [{ ...receipt(), status: "rejected" }, "rejected-publication"],
    [{ ...receipt(), status: "duplicate" }, "duplicate-publication"],
    [{ ...receipt(), status: "failed" }, "failed-publication"],
  ] as const) {
    const subject = oracle();
    subject.register(publication(), {
      phase: "measurement",
      plannedMs: 3,
      submittedMs: 3,
    });
    assert.throws(() => subject.recordReceipt(bad, 4), new RegExp(fault));
    assert.equal(subject.summary().phases.measurement.missingReceipts, 1);
    assert.equal(subject.summary().faults[fault], 1);
  }
  const sqlite = oracle({ storage: "sqlite" });
  sqlite.register(publication(), {
    phase: "seed",
    plannedMs: 3,
    submittedMs: 3,
  });
  sqlite.recordReceipt(
    { ...receipt(), status: "committed", reason: "sqlite" },
    4,
  );
  assert.equal(sqlite.pendingCount, 0);
  assert.throws(
    () =>
      sqlite.recordReceipt(
        { ...receipt(), status: "committed", reason: "sqlite" },
        5,
      ),
    /duplicate-receipt/,
  );
});

test("validate the entire intermediate payload, provenance, route, per-field sequence and version", () => {
  const baseline = frame("view-0");
  for (const [viewer, value, error] of [
    ["viewer-9", baseline, /unexpected-update/],
    ["viewer-0", { ...baseline, viewId: "unknown" }, /unexpected-update/],
    ["viewer-0", { ...baseline, type: "subscribed" }, /unexpected-update/],
    ["viewer-0", { ...baseline, entityId: "other" }, /mismatched-update/],
    [
      "viewer-0",
      { ...baseline, provenance: { value: { ...source, sourceId: "other" } } },
      /unexpected-update/,
    ],
    [
      "viewer-0",
      { ...baseline, publicationSequences: { value: [2] } },
      /unexpected-update/,
    ],
    [
      "viewer-0",
      { ...baseline, data: { value: { marker: "0:1", padding: "bad" } } },
      /mismatched-update/,
    ],
    [
      "viewer-0",
      { ...baseline, data: { value: { marker: "wrong", padding: "xx" } } },
      /mismatched-update/,
    ],
    ["viewer-0", { ...baseline, version: 72 }, /mismatched-update/],
  ] as const) {
    const subject = oracle();
    subject.register(publication(), {
      phase: "measurement",
      plannedMs: 0,
      submittedMs: 0,
    });
    subject.recordReceipt(receipt(), 1);
    assert.throws(() => subject.recordUpdate(viewer, value, 2), error);
    assert.equal(subject.summary().phases.measurement.validUpdates, 0);
  }
  const subject = oracle();
  assert.doesNotThrow(() =>
    subject.verifySnapshot("view-0", publication(), baseline),
  );
  assert.throws(
    () => subject.verifySnapshot("view-0", publication(2), baseline),
    /mismatched-snapshot/,
  );
});

test("reject duplicate frames during and after fan-out, and inversions on a FIFO viewer lane", () => {
  const subject = oracle();
  subject.register(publication(1), {
    phase: "measurement",
    plannedMs: 0,
    submittedMs: 0,
  });
  subject.recordUpdate("viewer-0", frame("view-0"), 1);
  assert.throws(
    () => subject.recordUpdate("viewer-0", frame("view-0"), 2),
    /duplicate-update/,
  );
  assert.throws(
    () => subject.recordReceipt(receipt(1, 999), 2),
    /mismatched-receipt/,
  );
  subject.recordReceipt(receipt(), 2);
  assert.throws(() => subject.recordReceipt(receipt(), 3), /duplicate-receipt/);
  subject.recordUpdate("viewer-0", frame("view-1"), 3);
  for (const view of views) {
    subject.recordUpdate("viewer-1", frame(view), 3);
  }
  assert.throws(
    () => subject.recordUpdate("viewer-1", frame("view-0"), 4),
    /duplicate-update/,
  );
  for (const seq of [2, 3]) {
    subject.register(publication(seq), {
      phase: "measurement",
      plannedMs: 4,
      submittedMs: 4,
    });
  }
  subject.recordUpdate("viewer-1", frame("view-0", 3, 80), 5);
  assert.throws(
    () => subject.recordUpdate("viewer-1", frame("view-0", 2, 79), 6),
    /out-of-order-update/,
  );
});

test("pending, entry and byte ceilings stop explicitly without counting the failed observation", () => {
  for (const [options, reason] of [
    [{ maxPending: 1 }, /pending publication limit/],
    [{ maxEntries: 1 }, /observation limit/],
  ] as const) {
    const subject = oracle(options);
    subject.register(publication(), {
      phase: "measurement",
      plannedMs: 0,
      submittedMs: 0,
    });
    assert.throws(
      () =>
        subject.register(publication(2), {
          phase: "measurement",
          plannedMs: 1,
          submittedMs: 1,
        }),
      reason,
    );
    assert.equal(subject.summary().phases.measurement.submitted, 1);
    assert.equal(subject.summary().rawEntries, 1);
  }
  const limited = oracle({ maxBytes: 10 });
  assert.throws(
    () =>
      limited.register(publication(), {
        phase: "measurement",
        plannedMs: 0,
        submittedMs: 0,
      }),
    BenchmarkLimit,
  );
  assert.equal(limited.pendingCount, 0);
  assert.equal(limited.summary().encodedBytes, 0);
});

test("retain the send boundary and refuse a send when evidence storage is full", () => {
  let sends = 0;
  const timing = {
    phase: "seed" as const,
    plannedMs: 10,
    submittedMs: () => {
      sends++;
      return 12.5;
    },
  };
  const subject = oracle({ maxEntries: 1 });
  subject.register(publication(), timing);
  assert.equal(sends, 1);
  assert.equal(
    JSON.parse(Buffer.concat([...subject.rawChunks()]).toString()).atMs,
    12.5,
  );
  assert.throws(() => subject.register(publication(2), timing), BenchmarkLimit);
  assert.equal(sends, 1);
  const unsubmitted = oracle();
  assert.throws(
    () =>
      unsubmitted.register(publication(), {
        ...timing,
        submittedMs: () => {
          throw new Error("send failed");
        },
      }),
    /send failed/,
  );
  assert.equal(unsubmitted.summary().phases.seed.submitted, 0);
});
