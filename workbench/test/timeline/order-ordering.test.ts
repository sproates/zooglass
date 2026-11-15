import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { runDocument } from "../../src/timeline/run-document.js";
import { action } from "./document-fixture.js";
import {
  control,
  controlActor,
  controlAssertion,
  orderDocument,
  orderFiles,
  watermark,
} from "./order-document-fixture.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);

test("same-time Order controls preserve declaration order and both views for two clients", async (t) => {
  const doc = orderDocument(0);
  const secondActor = "a-progress";
  const clients = ["z-client", "a-client"];
  const views = ["order-summary", "order-tracking"];
  doc.actors.push(
    { id: secondActor, role: "progress" },
    ...clients.map((id) => ({ id, role: "client" })),
  );
  doc.links = doc.actors.map(({ id }) => ({ actor: id, latencyMs: 0 }));
  doc.actions = [
    ...doc.actors.map(({ id }) => action(`connect-${id}`, 0, "connect", id)),
    ...clients.flatMap((client) =>
      views.map((viewId) =>
        action(`subscribe-${client}-${viewId}`, 0, "client-subscribe", client, {
          viewId,
          entityId: "order-1",
        }),
      ),
    ),
    action("first", 10, "progress-send", controlActor, { control }),
    action("second", 10, "progress-send", secondActor, {
      control: { ...control, throughSequence: 4 },
    }),
  ];
  doc.assertions = [
    controlAssertion("first-ack", 10, [watermark()]),
    {
      ...controlAssertion("second-ack", 10, [
        { ...watermark(), throughSequence: 4, version: 2 },
      ]),
      actor: secondActor,
    },
  ];
  doc.untilMs = 10;
  const input = await orderFiles(doc);
  t.after(input.close);
  const run = await runDocument(input.path, { jar });
  assert.equal(run.outcome, "passed", run.message);
  const records = run.trace
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const controls = records.filter((event) => event.kind === "control-receipt");
  assert.deepEqual(
    controls.map((event) => [
      event.actor,
      event.data.envelope.throughSequence,
      event.data.envelope.version,
    ]),
    [
      [controlActor, 3, 1],
      [secondActor, 4, 2],
    ],
  );
  assert.ok(
    controls.every(
      (event) =>
        event.key[0] === 10 && event.key[1] === 0 && event.key[2] === 2,
    ),
  );

  const state = records.filter((event) => event.kind === "state");
  assert.deepEqual(
    state.map((event) => [
      event.data.envelope.viewId,
      event.data.envelope.version,
    ]),
    [
      ["order-summary", 1],
      ["order-tracking", 1],
      ["order-summary", 2],
      ["order-tracking", 2],
    ],
  );
  const delivered = records.filter(
    (event) =>
      event.kind === "delivered" && event.data.channel === "client-frame",
  );
  for (const client of clients) {
    const frames = delivered
      .filter((event) => event.actor === client)
      .map((event) => event.data.envelope);
    assert.deepEqual(
      frames.map((frame) => [frame.type, frame.viewId, frame.version ?? null]),
      [
        ["subscribed", "order-summary", null],
        ["view-update", "order-summary", 0],
        ["subscribed", "order-tracking", null],
        ["view-update", "order-tracking", 0],
        ["view-update", "order-summary", 1],
        ["view-update", "order-tracking", 1],
        ["view-update", "order-summary", 2],
        ["view-update", "order-tracking", 2],
      ],
    );
    for (const frame of frames.filter((candidate) => candidate.version > 0)) {
      const through = frame.version === 1 ? 3 : 4;
      assert.deepEqual(frame.data, {});
      assert.equal(
        frame.status.publication,
        frame.viewId === "order-summary" ? "partial" : "waiting",
      );
      assert.deepEqual(frame.status.inputs.orders, {
        state: "observed",
        mode: "contiguousSequence",
        epoch: "run",
        sourceEntityId: "order-1",
        startSequence: 1,
        observedThrough: through,
        watermarkThrough: through,
        completeThrough: null,
        completeness: "incomplete",
        admissionFloor: 1,
        sourceContractViolated: false,
        missingRanges: [{ from: 1, through, status: "confirmed" }],
      });
    }
  }
  const updates = delivered.filter((event) => event.data.envelope.version > 0);
  assert.ok(updates.every((event) => event.key[0] === 10 && event.key[1] > 0));
  assert.deepEqual(
    updates.map((event) => event.actor),
    [
      "z-client",
      "a-client",
      "z-client",
      "a-client",
      "z-client",
      "a-client",
      "z-client",
      "a-client",
    ],
  );
});
