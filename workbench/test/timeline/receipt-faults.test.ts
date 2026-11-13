import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fixture, files } from "./document-fixture.js";
import { receiptDraw } from "../../src/timeline/receipt-faults.js";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import { runDocument } from "../../src/timeline/run-document.js";
import { replayDocument } from "../../src/timeline/replay-document.js";
import { canonicalJson } from "../../src/timeline/json.js";
import { validateTrace } from "../../src/timeline/trace-contract.js";
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
const key = {
  seed: "0".repeat(64),
  scenario: "warehouse-retry-and-expiry",
  rule: "lose-first",
  actor: "viewer-logical-source",
  action: "send-1",
  generation: 1,
  attempt: 1,
};
const rejectionSeed =
  "00000000000000000000000000000000000000000000000000000000000125f6";
function faultFixture(
  numerator = 1,
  denominator = 1,
  seed = "0".repeat(64),
  lost = true,
) {
  const f = fixture();
  const document = {
    ...f.document,
    faults: [
      {
        id: "lose-first",
        kind: "receipt-loss",
        action: "send-1",
        probability: { numerator, denominator },
      },
    ],
  };
  document.seed = seed;
  if (lost)
    document.assertions.find((a) => a.id === "receipts")!.expected.shift();
  return { configuration: f.configuration, document };
}
const records = (trace: string) =>
  trace
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));

test("receipt loss closes the source generation before a same-generation retry", async () => {
  const f = faultFixture();
  f.document.actions = f.document.actions.filter(
    (action) => !["source-disconnect", "source-reconnect"].includes(action.id),
  );
  const input = await files(f);
  try {
    const run = await runDocument(input.path, { jar });
    assert.equal(run.outcome, "infrastructure-failed");
    assert.match(run.message!, /runtime-closed connection/);
    const trace = records(run.trace);
    const closed = trace.filter(
      (event) =>
        event.kind === "connection-closed" && event.actor === key.actor,
    );
    assert.equal(closed.length, 1);
    assert.equal(closed[0].connectionGeneration, 1);
    assert.ok(
      !trace.some(
        (event) => event.kind === "action" && event.data.actionId === "retry",
      ),
    );
    assert.ok(
      !trace.some(
        (event) =>
          event.kind === "receipt" &&
          event.data.envelope.status === "duplicate",
      ),
    );
  } finally {
    await input.close();
  }
});

test("receipt draws match independently computed Python SHA-256 vectors, including rejection", () => {
  const first = receiptDraw(key, 1, 2, 0);
  assert.equal(
    first.digest,
    "5cb0737513a4f08d39691341480833fdc36eda57e1a3429b1b148c66adb53787",
  );
  assert.equal(first.sample, 1555067765);
  assert.equal(first.lost, false);
  const second = receiptDraw({ ...key, seed: "2".repeat(64) }, 1, 2, 0);
  assert.equal(
    second.digest,
    "2fd34016cde71843be30a1efc8a9b90bbe7a60c8a649a016dcc8e6ec891ef3ab",
  );
  assert.equal(second.lost, true);
  const rejected = receiptDraw(
    { ...key, seed: rejectionSeed },
    999983,
    999983,
    0,
  );
  assert.equal(
    rejected.digest,
    "ffffc34eef22cca575ad652474aa24098cc8f4e109b18fa195afa815b5f4b736",
  );
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.lost, false);
  const accepted = receiptDraw(
    { ...key, seed: rejectionSeed },
    999983,
    999983,
    1,
  );
  assert.equal(
    accepted.digest,
    "85d4d619cc14d73aaa3cceff6aad20ce7683a7b696ff8c4839fc9c86d2776e48",
  );
  assert.equal(accepted.rejected, false);
  assert.equal(accepted.lost, true);
});

test("fault grammar rejects unknown kinds, targets, overlaps and invalid probabilities", () => {
  for (const faults of [
    null,
    [{ ...faultFixture().document.faults[0], kind: "delay" }],
    [{ ...faultFixture().document.faults[0], action: "subscribe" }],
    [...faultFixture().document.faults, ...faultFixture().document.faults],
    [
      {
        ...faultFixture().document.faults[0],
        probability: { numerator: 2, denominator: 1 },
      },
    ],
    [
      {
        ...faultFixture().document.faults[0],
        probability: { numerator: 0, denominator: 0 },
      },
    ],
  ]) {
    const f = faultFixture();
    f.document.runtime.sha256 = "0".repeat(64);
    assert.throws(() =>
      parseTimelineDocument(JSON.stringify({ ...f.document, faults })),
    );
  }
});

test("receipt loss leaves committed views intact, explicit retry receives duplicate, and fresh replay verifies decisions", async () => {
  const input = await files(faultFixture());
  try {
    const run = await runDocument(input.path, { jar });
    assert.equal(run.outcome, "passed", run.message);
    const trace = records(run.trace);
    const decision = trace.find((e) => e.kind === "fault-decision");
    const dropped = trace.find(
      (e) => e.kind === "dropped" && e.data.reason === "receipt-loss",
    );
    assert.equal(decision.data.lost, true);
    const closeCommand = trace.find(
      (e) => e.kind === "runtime-command" && e.data.op === "disconnect",
    );
    const closed = trace.find(
      (e) => e.kind === "connection-closed" && e.actor === key.actor,
    );
    assert.equal(closeCommand.parentId, decision.eventId);
    assert.deepEqual(closeCommand.key.slice(0, 3), [
      10,
      decision.key[1] + 1,
      0,
    ]);
    assert.equal(closed.parentId, closeCommand.eventId);
    assert.equal(closed.connectionGeneration, 1);
    assert.equal(dropped.data.messageId, decision.data.messageId);
    assert.deepEqual(dropped.causes, [decision.eventId]);
    assert.equal(
      trace.filter(
        (e) => e.kind === "delivered" && e.data.channel === "source-receipt",
      ).length,
      2,
    );
    assert.equal(
      trace.find(
        (e) => e.kind === "receipt" && e.data.envelope.status === "duplicate",
      ).data.envelope.version,
      1,
    );
    assert.equal(
      trace.find(
        (e) => e.kind === "receipt" && e.data.envelope.status === "duplicate",
      ).connectionGeneration,
      2,
    );
    const saved = input.path + ".run.json";
    await writeFile(saved, JSON.stringify(run));
    const replay = await replayDocument(saved, {
      jar,
      hostDelay: 1,
      paced: true,
      idlePauseMs: 60,
    });
    assert.equal(replay.status, "verified");
    assert.equal(replay.actual.trace, run.trace);
    const lines = run.trace.trimEnd().split("\n");
    const index = trace.findIndex((e) => e.kind === "fault-decision");
    const changed = {
      ...decision,
      data: { ...decision.data, ruleId: "tampered" },
    };
    lines[index] = canonicalJson(JSON.stringify(changed));
    await writeFile(
      saved,
      JSON.stringify({ ...run, trace: lines.join("\n") + "\n" }),
    );
    const divergence = await replayDocument(saved, { jar });
    assert.equal(divergence.status, "diverged");
    assert.equal(divergence.divergence?.record, index);
    changed.data.lost = false;
    lines[index] = canonicalJson(JSON.stringify(changed));
    assert.throws(() => validateTrace(lines.join("\n") + "\n"), /draw outcome/);
  } finally {
    await input.close();
  }
});

test("same-time source burst closes once and invalidates every queued old-generation receipt", async () => {
  const f = faultFixture();
  const second = {
    ...f.document.actions.find((action) => action.id === "send-2")!,
    atMs: 10,
  };
  f.document.actions = [
    ...f.document.actions.slice(0, 4),
    second,
    { ...second, id: "send-3", publication: "report-3" },
  ];
  f.document.faults.push({
    ...f.document.faults[0],
    id: "lose-second",
    action: "send-2",
  });
  f.document.assertions = [
    {
      id: "no-old-receipts",
      atMs: 110,
      kind: "source-receipts",
      actor: key.actor,
      expected: [],
    },
  ];
  const input = await files(f);
  try {
    const run = await runDocument(input.path, { jar });
    assert.equal(run.outcome, "passed", run.message);
    const trace = records(run.trace);
    const closes = trace.filter(
      (e) => e.kind === "connection-closed" && e.actor === key.actor,
    );
    assert.equal(closes.length, 1);
    assert.equal(
      trace.filter(
        (e) => e.kind === "runtime-command" && e.data.op === "disconnect",
      ).length,
      1,
    );
    assert.equal(trace.filter((e) => e.kind === "fault-decision").length, 2);
    const dropped = trace.filter(
      (e) => e.kind === "dropped" && e.actor === key.actor,
    );
    assert.deepEqual(
      dropped.map((e) => [e.connectionGeneration, e.data.reason]),
      [
        [1, "receipt-loss"],
        [1, "receipt-loss"],
        [1, "connection-closed"],
      ],
    );
    assert.deepEqual(dropped[2].causes, [closes[0].eventId]);
    const states = trace.filter((e) => e.kind === "state");
    assert.deepEqual(
      states.map((e) => e.data.envelope.version),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      states.map((e) => e.data.envelope.data.reading.payload.amount),
      [1, 2, 3, 3],
    );
  } finally {
    await input.close();
  }
});

test("zero, half and certain probabilities have independently expected delivery outcomes", async () => {
  for (const [numerator, denominator, seed, lost] of [
    [0, 1, "0".repeat(64), false],
    [1, 2, "0".repeat(64), false],
    [1, 2, "2".repeat(64), true],
  ] as const) {
    const input = await files(faultFixture(numerator, denominator, seed, lost));
    try {
      const run = await runDocument(input.path, { jar });
      assert.equal(run.outcome, "passed", run.message);
      assert.equal(
        records(run.trace).find((e) => e.kind === "fault-decision").data.lost,
        lost,
      );
    } finally {
      await input.close();
    }
  }
});

test("adding an unrelated actor leaves keyed draws unchanged, and rejected draws remain in the trace", async () => {
  const f = faultFixture(999983, 999983, rejectionSeed);
  f.document.actors.push({ id: "unrelated", role: "source" });
  f.document.links.push({ actor: "unrelated", latencyMs: 0 });
  f.document.actions.unshift({
    id: "other-connect",
    atMs: 0,
    kind: "connect",
    actor: "unrelated",
  });
  const input = await files(f);
  try {
    const run = await runDocument(input.path, { jar });
    assert.equal(run.outcome, "passed", run.message);
    const draws = records(run.trace).filter((e) => e.kind === "fault-decision");
    assert.deepEqual(
      draws.map((d) => [d.data.drawIndex, d.data.rejected, d.data.lost]),
      [
        [0, true, false],
        [1, false, true],
      ],
    );
    assert.equal(
      draws[0].data.digest,
      "ffffc34eef22cca575ad652474aa24098cc8f4e109b18fa195afa815b5f4b736",
    );
    assert.equal(
      draws[1].data.digest,
      "85d4d619cc14d73aaa3cceff6aad20ce7683a7b696ff8c4839fc9c86d2776e48",
    );
  } finally {
    await input.close();
  }
});
