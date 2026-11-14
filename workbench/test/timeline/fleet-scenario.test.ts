import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildDocument,
  configurationWire,
  documentWire,
  checkpoints,
  events,
  frame,
  framesAt,
  receipt,
  snapshot,
  states,
  subscriptions,
  values,
} from "../../scenarios/timeline-fleet/author.js";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import { runDocument } from "../../src/timeline/run-document.js";

const directory = resolve("scenarios/timeline-fleet");
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
type LegacyEntry = {
  kind: string;
  simulationTime: number;
  sourceId: string;
  epoch: string;
  entityId: string;
  publicationSequence: number;
  type: string;
  payload: unknown;
  expectedRejection?: string;
  viewId: string;
  expected: unknown;
};

test("authored fleet document is reproducible and preserves every legacy input and checkpoint", async () => {
  assert.equal(
    await readFile(join(directory, "runtime.json"), "utf8"),
    configurationWire,
  );
  assert.equal(
    await readFile(join(directory, "scenario.json"), "utf8"),
    documentWire(),
  );
  const document = buildDocument();
  assert.equal(
    parseTimelineDocument(JSON.stringify(document)).profile,
    "memory-sequence-fleet-v1",
  );
  const legacy = JSON.parse(
    await readFile(resolve("scenarios/vehicle-fleet-contracts.json"), "utf8"),
  ) as { timeline: LegacyEntry[] };
  const publications = legacy.timeline.filter(
    (entry) => entry.kind === "source-event",
  );
  assert.equal(publications.length, 16);
  assert.deepEqual(
    document.publications.map(({ body }, index) => ({
      at: events[index].at,
      ...body,
    })),
    publications.map((entry) => ({
      at: entry.simulationTime,
      sourceId: entry.sourceId,
      epoch: entry.epoch,
      sourceEntityId: entry.entityId,
      publicationSequence: entry.publicationSequence,
      type: entry.type,
      payload: entry.payload,
    })),
  );
  assert.deepEqual(
    events.map((event) =>
      event.status === "rejected" ? "identityConflict" : undefined,
    ),
    publications.map((entry) => entry.expectedRejection),
  );
  assert.deepEqual(
    subscriptions.map(([at, name]) => ({
      at,
      viewId: states[name].view,
      entityId: states[name].entity,
    })),
    legacy.timeline
      .filter((entry) => entry.kind === "client-subscription")
      .map((entry) => ({
        at: entry.simulationTime,
        viewId: entry.viewId,
        entityId: entry.entityId,
      })),
  );
  const legacyChecks = legacy.timeline.filter((entry) =>
    ["client-view-check", "view-check"].includes(entry.kind),
  );
  assert.equal(checkpoints.length, 20);
  assert.deepEqual(
    checkpoints.map(([at, kind, name]) => ({
      at,
      kind,
      viewId: states[name].view,
      entityId: states[name].entity,
      data: frame(name).data,
    })),
    legacyChecks.map((entry) => ({
      at: entry.simulationTime,
      kind: entry.kind === "client-view-check" ? "client" : "runtime",
      viewId: entry.viewId,
      entityId: entry.entityId,
      data: entry.expected,
    })),
  );
  for (const [at, kind, name] of checkpoints) {
    if (kind !== "client") continue;
    const expected = frame(name);
    assert.deepEqual(
      framesAt(at)
        .filter(
          (value) =>
            value.type === "view-update" &&
            value.viewId === expected.viewId &&
            value.entityId === expected.entityId,
        )
        .at(-1),
      expected,
    );
  }
  assert.equal(document.observationTargets.length, 6);
  assert.equal(framesAt(450).length, 28);
  assert.deepEqual(
    [
      states.f17latest.version,
      states.j17late.version,
      states.f28latest.version,
      states.j28first.version,
      states.f39final.version,
      states.j39latest.version,
    ],
    [7, 9, 8, 2, 12, 11],
  );
  assert.deepEqual(receipt(events[10]).targets, receipt(events[8]).targets);
  assert.deepEqual(receipt(events[12]).targets, receipt(events[7]).targets);
});

test("prepared runtime satisfies all independently authored fleet observations", async () => {
  const run = await runDocument(join(directory, "scenario.json"), { jar });
  assert.equal(run.outcome, "passed", run.message ?? "fleet run failed");
});

test("fleet oracles reject unsorted history, missing fanout and accepted identity conflicts", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "fleet-negative-oracles-"));
  try {
    await writeFile(join(temporary, "runtime.json"), configurationWire);
    const cases = [
      {
        id: "wrong-history-order",
        atMs: 260,
        kind: "runtime-snapshot",
        viewId: "received-journey",
        entityId: "car-17",
        expected: {
          outcome: "available",
          snapshot: {
            ...snapshot("j17late"),
            data: {
              positions: [values.p17a, values.p17c, values.p17b].map(
                (payload) => ({
                  publicationSequence: payload.sequence,
                  payload,
                }),
              ),
            },
          },
        },
      },
      {
        id: "missing-second-view-fanout",
        atMs: 60,
        kind: "source-receipts",
        actor: "vehicle-feed",
        expected: [
          {
            ...receipt(events[0]),
            changedViews: ["fleet-state"],
            targets: [receipt(events[0]).targets[0]],
          },
        ],
      },
      {
        id: "conflicting-identity-accepted",
        atMs: 280,
        kind: "source-receipts",
        actor: "vehicle-feed",
        expected: events
          .filter((event) => event.source === "vehicle-feed" && event.at <= 280)
          .map((event) =>
            event.at === 280
              ? { ...receipt(event), status: "applied", reason: "memory" }
              : receipt(event),
          ),
      },
    ];
    for (const wrong of cases) {
      const document = { ...buildDocument(), assertions: [wrong] };
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
