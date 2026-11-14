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
} from "../../scenarios/timeline-order/author.js";
import { inputs } from "../../scenarios/timeline-order/inputs.js";
import {
  receipt,
  receiptRows,
  expiries,
} from "../../scenarios/timeline-order/receipts.js";
import { canonicalJson } from "../../src/timeline/json.js";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import { runDocument } from "../../src/timeline/run-document.js";
const directory = resolve("scenarios/timeline-order");
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
const digest = (wire: string | Buffer) =>
  createHash("sha256").update(wire).digest("hex");

test("ordinary Order inputs preserve the pinned six-order two-cycle schedule and bounded document", async () => {
  const input = inputs(),
    document = buildDocument();
  // Independently exported from ad04db982cf32e4f26919a7ffbbb042e48212a78's
  // orders/contracts.ts and timeline.ts, epoch1700000000000, tick3000. This
  // projection retains all payloads, original ticks, omission and retry intents.
  const projection = {
    publications: input.sends.map((send) => ({
      tick: send.tick,
      retry: send.retry,
      unmapped: send.unmapped,
      body: send.body,
    })),
    controls: input.controls.map((control) => ({
      tick: control.tick,
      control: control.control,
    })),
    omissions: input.omissions,
    connections: input.connections.map((connection) => ({
      tick: connection.tick,
      kind: connection.kind,
      source: connection.source,
      atMs: connection.atMs,
    })),
  };
  assert.equal(
    digest(canonicalJson(JSON.stringify(projection))),
    "90404ff75531c7b8dac63700e40ea018e7052a43a147af0075376e43f3f9ca2e",
  );
  assert.equal(
    digest(await readFile(join(directory, "runtime.json"))),
    configurationSha256,
  );
  assert.equal(
    await readFile(join(directory, "scenario.json"), "utf8"),
    documentWire(),
  );
  assert.equal(
    parseTimelineDocument(JSON.stringify(document)).profile,
    "sqlite-order-v1",
  );
  assert.equal(document.publications.length, 170);
  assert.equal(input.sends.length, 183);
  assert.equal(input.controls.length, 36);
  assert.equal(input.omissions.length, 1);
  assert.equal(document.actors.length, 7);
  assert.equal(
    document.actions.filter((action) => action.kind === "connect").length,
    9,
  );
  assert.equal(document.observationTargets.length, 12);
  assert.equal(
    document.actions.filter((action) => action.kind === "client-subscribe")
      .length,
    2,
  );
  const bodies = new Map(
    document.publications.map((publication) => [
      publication.id,
      publication.body,
    ]),
  );
  const sends = document.actions.filter(
    (action) => action.kind === "source-send" || action.kind === "source-retry",
  );
  assert.deepEqual(
    sends.map((action) => ({
      atMs: action.atMs,
      kind: action.kind,
      body: bodies.get(
        (action as unknown as { publication: string }).publication,
      ),
    })),
    input.sends.map((send) => ({
      atMs: send.atMs,
      kind: send.retry ? "source-retry" : "source-send",
      body: send.body,
    })),
  );
  assert.equal(
    sends.filter((action) => action.kind === "source-retry").length,
    13,
  );
  for (let tick = 0; tick < 72; tick++) {
    const emitted = [...input.sends, ...input.controls]
      .filter((item) => item.tick === tick)
      .sort((a, b) => a.atMs - b.atMs);
    assert.deepEqual(
      emitted.map((item) => item.atMs),
      emitted.map((_, slot) => tick * 3000 + 10 + slot),
    );
    assert.equal(
      receiptRows[tick]?.length ?? 0,
      input.sends.filter((send) => send.tick === tick).length,
    );
  }
  for (const retry of input.sends.filter((send) => send.retry)) {
    const original = input.sends.find(
      (send) =>
        !send.retry &&
        canonicalJson(JSON.stringify(send.body)) ===
          canonicalJson(JSON.stringify(retry.body)),
    )!;
    const retained = receipt(original),
      duplicate = receipt(retry);
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.reason, "alreadyCommitted");
    assert.equal(duplicate.version, retained.version);
    assert.deepEqual(duplicate.targets, retained.targets);
    assert.deepEqual(duplicate.changedViews, []);
  }
  assert.equal(expiries.length, 36);
  assert.equal(framesAt(213000).length, 64);
  assert.equal(document.assertions.length, 129);
  assert.equal(document.end.pendingFutureTasks, "allow");
});

test("prepared Order runtime satisfies complete authored receipts, frames and installed snapshots", async () => {
  const run = await runDocument(join(directory, "scenario.json"), { jar });
  assert.equal(run.outcome, "passed", run.message ?? "Order run did not pass");
});

test("Order oracles reject wrong priority, late replacement, gap completion and mapped diagnostic payment", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "order-negative-oracles-"));
  try {
    await writeFile(
      join(temporary, "runtime.json"),
      await readFile(join(directory, "runtime.json")),
    );
    // Mutation tests intentionally author valid but incorrect full expectations.
    // No observation from an executing runtime is used to construct an oracle.
    type Assertion = {
      id: string;
      atMs: number;
      kind: string;
      expected: Record<string, unknown> | unknown[];
      [key: string]: unknown;
    };
    const original = buildDocument();
    const copy = (id: string) =>
      structuredClone(
        original.assertions.find((assertion) => assertion.id === id)!,
      ) as Assertion;
    const wrongPriority = copy("fresh-backup-stale-primary-order-summary");
    const wrongLate = copy("late-order-closes-gap-order-summary");
    const wrongGap = copy("cycle-one-final-2-order-summary");
    const wrongMapping = copy("complete-payments-receipts-105100");
    const snapshotOf = (assertion: Assertion) =>
      (assertion.expected as { snapshot: Record<string, unknown> }).snapshot;
    const input = inputs();
    const backup = input.sends.find((send) => send.id === "p29-0")!;
    const priority = snapshotOf(wrongPriority);
    (priority.data as Record<string, unknown>).delivery = {
      publicationSequence: 22,
      payload: backup.body.payload,
    };
    (priority.provenance as Record<string, unknown>).delivery = {
      sourceId: "courier-backup",
      epoch: "run",
      sourceEntityId: "tracking-1",
    };
    const late = snapshotOf(wrongLate),
      packing = input.sends.find((send) => send.id === "p6-0")!;
    (late.data as Record<string, unknown>).order = {
      publicationSequence: 2,
      payload: packing.body.payload,
    };
    const gap = snapshotOf(wrongGap);
    const paymentProgress = (
      gap.status as { inputs: Record<string, Record<string, unknown>> }
    ).inputs.payments;
    paymentProgress.completeThrough = 4;
    paymentProgress.completeness = "completeThrough";
    paymentProgress.missingRanges = [];
    const receipts = wrongMapping.expected as {
      targets: {
        entityId: string | null;
        status: string;
        reason: string | null;
      }[];
    }[];
    receipts.at(-1)!.targets[0].entityId = "order-1";
    receipts.at(-1)!.targets[0].status = "accepted";
    receipts.at(-1)!.targets[0].reason = null;
    for (const wrong of [wrongPriority, wrongLate, wrongGap, wrongMapping]) {
      const document = { ...original, assertions: [wrong] };
      assert.doesNotThrow(() =>
        parseTimelineDocument(JSON.stringify(document)),
      );
      const path = join(temporary, `${wrong.id}.json`);
      await writeFile(path, JSON.stringify(document));
      const run = await runDocument(path, { jar });
      assert.equal(run.outcome, "assertion-failed");
      assert.equal(run.message, `assertion-failed: ${wrong.id}`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
