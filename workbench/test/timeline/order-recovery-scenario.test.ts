import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildDocument,
  configurationSha256,
  documentWire,
  framesAt,
  recoverySnapshots,
} from "../../scenarios/timeline-order-recovery/author.js";
import {
  epoch,
  source,
  variants,
  type Variant,
} from "../../scenarios/timeline-order-recovery/inputs.js";
import {
  receipt,
  snapshot,
  watermark,
} from "../../scenarios/timeline-order-recovery/oracle.js";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import { runDocument } from "../../src/timeline/run-document.js";
const directory = resolve("scenarios/timeline-order-recovery");
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
const names = Object.keys(variants) as Variant[];

test("authored Order recovery documents preserve exact config, bounded connections and original duplicate outcomes", async () => {
  const configuration = await readFile(join(directory, "runtime.json"));
  assert.equal(
    createHash("sha256").update(configuration).digest("hex"),
    configurationSha256,
  );
  for (const variant of names) {
    const document = buildDocument(variant);
    assert.equal(
      await readFile(join(directory, `${variant}.json`), "utf8"),
      documentWire(variant),
    );
    assert.equal(
      parseTimelineDocument(JSON.stringify(document)).profile,
      "sqlite-order-restart-v1",
    );
    assert.equal(document.actors.length, 4);
    assert.equal(
      document.actions.filter((action) => action.kind === "connect").length,
      8,
    );
    assert.equal(document.observationTargets.length, 4);
    assert.equal(
      document.actions.filter((action) => action.kind === "client-subscribe")
        .length,
      16,
    );
    assert.equal(
      document.links.find((link) => link.actor === "order-progress")!.latencyMs,
      10,
    );
    assert.equal(document.untilMs, variants[variant].until);
    assert.deepEqual(
      recoverySnapshots(variant).map((snapshot) => snapshot.version),
      variant === "before"
        ? [8, 8, 7, 7]
        : variant === "at"
          ? [9, 9, 7, 7]
          : [9, 9, 9, 9],
    );
    assert.equal(
      framesAt(variant, variants[variant].until).length,
      variant === "after" ? 42 : 34,
    );
  }
  const original = receipt("primary2"),
    duplicate = receipt("primary2", true);
  assert.equal(duplicate.version, 7);
  assert.deepEqual(duplicate.targets, original.targets);
  assert.deepEqual(duplicate.targets[1].changedFields, []);
  assert.equal(duplicate.targets[1].fields[0].changed, false);
  assert.deepEqual(duplicate.changedViews, []);
  assert.deepEqual(watermark("A", true), {
    ...watermark("A"),
    status: "duplicate",
    reason: "alreadyCommitted",
    changedViews: [],
  });
  assert.equal(
    receipt("nextOrder2").version,
    10,
    "hidden backup-only recovery commits still consume version9",
  );
  assert.equal(
    snapshot("recoveredBefore1", "order-summary", "before").status.fields
      .inventory.receivedAtMillis,
    epoch + 20,
  );
  assert.equal(
    snapshot("recoveredAfter1", "order-summary", "after").status.fields.delivery
      .receivedAtMillis,
    epoch + 21,
  );
});

for (const variant of names)
  test(`prepared Order ${variant}-boundary recovery retains complete baselines, ages, receipts and control ownership`, async () => {
    const diagnosticDirectory = await mkdtemp(
      join(tmpdir(), `order-recovery-${variant}-`),
    );
    try {
      const run = await runDocument(join(directory, `${variant}.json`), {
        jar,
        diagnosticDirectory,
      });
      assert.equal(
        run.outcome,
        "passed",
        run.message ?? "Order recovery did not pass",
      );
      const records = run.trace
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const initialized = records.filter(
        (record) => record.kind === "runtime-initialized",
      );
      assert.equal(initialized.length, 2);
      // This record precedes all reconnect/subscription/publication inputs. The
      // before/at variants deliberately publish again at the restart timestamp.
      assert.deepEqual(
        initialized[1].data.snapshots,
        recoverySnapshots(variant),
      );
      assert.equal(initialized[1].data.startTimeMs, variants[variant].restart);
      assert.equal(
        initialized[1].data.wallMillis,
        epoch + variants[variant].restart,
      );
      assert.equal(initialized[1].data.monotonicMs, 0);
      assert.deepEqual(initialized[0].data.snapshots, [
        snapshot("empty1", "order-summary", variant),
        snapshot("empty1", "order-tracking", variant),
        snapshot("empty2", "order-summary", variant),
        snapshot("empty2", "order-tracking", variant),
      ]);
      assert.equal(run.execution.profile, "sqlite-order-restart-v1");
      assert.equal(records.at(-1).pendingMessages, 0);
      assert.equal(records.at(-1).heldFrames, 0);
    } finally {
      await rm(diagnosticDirectory, { recursive: true, force: true });
    }
  });

test("recovery oracles reject refreshed duplicate age and a lost recovery version", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "order-recovery-negative-"));
  try {
    await writeFile(
      join(temporary, "runtime.json"),
      await readFile(join(directory, "runtime.json")),
    );
    const after = buildDocument("after"),
      before = buildDocument("before");
    const wrongAge = structuredClone(
      after.assertions.find(
        (assertion) =>
          assertion.id === "duplicate-retains-primary-age-order-summary",
      )!,
    ) as unknown as {
      id: string;
      expected: {
        snapshot: {
          status: {
            fields: {
              delivery: { freshness: string; receivedAtMillis: number };
            };
          };
        };
      };
    };
    wrongAge.expected.snapshot.status.fields.delivery.freshness = "fresh";
    wrongAge.expected.snapshot.status.fields.delivery.receivedAtMillis =
      epoch + variants.after.restart + 1;
    const wrongVersion = {
      id: "hidden-backup-age-commit-missing",
      atMs: variants.before.until,
      kind: "source-receipts",
      actor: source,
      expected: [
        receipt("order1"),
        receipt("order2"),
        receipt("backup1"),
        receipt("backup2"),
        receipt("inventory1"),
        receipt("primary1"),
        receipt("primary2"),
        { ...receipt("nextOrder2"), version: 9 },
      ],
    };
    for (const [document, assertion] of [
      [after, wrongAge],
      [before, wrongVersion],
    ] as const) {
      const wrong = { ...document, assertions: [assertion] };
      assert.doesNotThrow(() => parseTimelineDocument(JSON.stringify(wrong)));
      const path = join(temporary, `${assertion.id}.json`);
      await writeFile(path, JSON.stringify(wrong));
      const run = await runDocument(path, {
        jar,
        diagnosticDirectory: temporary,
      });
      assert.equal(run.outcome, "assertion-failed");
      assert.equal(run.message, `assertion-failed: ${assertion.id}`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
