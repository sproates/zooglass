import assert from "node:assert/strict";
import test from "node:test";
import { Agenda } from "../../src/timeline/agenda.js";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import { DocumentTransport } from "../../src/timeline/document-transport.js";
import {
  metadataJson,
  SemanticTrace,
} from "../../src/timeline/semantic-trace.js";
import { TraceControls } from "../../src/timeline/trace-controls.js";
import type { TraceEvent } from "../../src/timeline/trace-generations.js";
import { object } from "../../src/timeline/validation.js";
import { control, orderDocument, watermark } from "./order-document-fixture.js";

function event(
  id: string,
  kind: string,
  data: unknown,
  parent: string | null = null,
  round = 0,
): TraceEvent {
  return {
    id,
    kind,
    parent,
    causes: [],
    actor: "progress",
    connectionGeneration: 1,
    runtimeGeneration: 1,
    timeMs: 10,
    key: [10, round, 2, 5],
    data: object(metadataJson(data), "data"),
  };
}
const action = () =>
  event("action", "action", {
    actionId: "p",
    actionKind: "progress-send",
    control,
  });
const receipt = () =>
  event(
    "receipt",
    "control-receipt",
    { messageId: "ack-1", envelope: watermark() },
    "action",
  );

test("zero-latency control cancellation preserves callback cause across causal rounds", () => {
  const trace = new TraceControls("sqlite-order-v1");
  trace.accept(action(), "action");
  trace.accept(receipt(), "receipt");
  const closed = event(
    "closed",
    "connection-closed",
    { code: 1000 },
    "action",
    1,
  );
  trace.accept(closed, "closed");
  const dropped = event(
    "dropped",
    "dropped",
    {
      messageId: "ack-1",
      channel: "progress-receipt",
      envelope: watermark(),
      reason: "connection-closed",
    },
    "receipt",
    2,
  );
  dropped.causes = ["closed"];
  trace.accept(dropped, "dropped");
  trace.finish("passed");
});

test("a close at the acknowledgement arrival time forbids delivery on the old generation", () => {
  const trace = new TraceControls("sqlite-order-v1");
  trace.accept(action(), "action");
  trace.accept(receipt(), "receipt");
  trace.accept(
    event(
      "link",
      "link-send",
      {
        messageId: "ack-1",
        channel: "progress-receipt",
        envelope: watermark(),
        deliverAtMs: 16,
      },
      "receipt",
    ),
    "link",
  );
  const closed = {
    ...event("closed", "connection-closed", { code: 1000 }),
    timeMs: 16,
    key: [16, 0, 0, 6],
  };
  trace.accept(closed, "closed");
  const delivery = {
    ...event(
      "delivery",
      "delivered",
      {
        messageId: "ack-1",
        channel: "progress-receipt",
        envelope: watermark(),
      },
      "link",
    ),
    timeMs: 16,
    key: [16, 0, 2, 7],
  };
  assert.throws(
    () => trace.accept(delivery, "delivery"),
    /closed connection generation/,
  );
  trace.accept(
    {
      ...delivery,
      kind: "dropped",
      parent: "closed",
      causes: ["link"],
      key: closed.key,
      data: { ...delivery.data, reason: "connection-closed" },
    },
    "drop",
  );
  const repeat = {
    ...action(),
    id: "repeat",
    connectionGeneration: 2,
    timeMs: 17,
    key: [17, 0, 2, 8],
  };
  trace.accept(repeat, "repeat");
  const duplicate = {
    ...repeat,
    id: "duplicate",
    kind: "control-receipt",
    parent: "repeat",
    data: object(
      metadataJson({ messageId: "ack-2", envelope: watermark(true) }),
      "data",
    ),
  };
  trace.accept(duplicate, "duplicate");
  trace.accept(
    {
      ...duplicate,
      id: "new-delivery",
      kind: "delivered",
      parent: "duplicate",
      key: [17, 1, 2, 9],
      data: { ...duplicate.data, channel: "progress-receipt" },
    },
    "new-delivery",
  );
  trace.finish("passed");
});

test("control lineage rejects duplicated acknowledgements, foreign ownership, and unsupported profile controls", () => {
  const trace = new TraceControls("sqlite-order-v1");
  trace.accept(action(), "action");
  trace.accept(receipt(), "receipt");
  assert.throws(
    () => trace.accept({ ...receipt(), id: "again" }, "again"),
    /already consumed/,
  );
  assert.throws(() => trace.finish("passed"), /unfinished control work/);
  const foreign = new TraceControls("sqlite-order-v1");
  foreign.accept(action(), "action");
  assert.throws(
    () => foreign.accept({ ...receipt(), actor: "other" }, "receipt"),
    /initiating request/,
  );
  for (const profile of [
    "receipt-age-restart-v1",
    "memory-sequence-fleet-v1",
    "memory-arrival-v1",
  ])
    assert.throws(
      () => new TraceControls(profile).accept(action(), "action"),
      /requires the SQLite Order/,
    );
  for (const actionKind of ["service-stop", "service-start", "wall-clock-set"])
    assert.throws(
      () =>
        new TraceControls("sqlite-order-v1").accept(
          event("runtime", "action", { actionKind }),
          "runtime",
        ),
      /does not support runtime lifecycle/,
    );
});

test("caught progress processing failures cannot become successful semantic observations", () => {
  const doc = orderDocument(0);
  doc.runtime.sha256 = "a".repeat(64);
  const scenario = parseTimelineDocument(JSON.stringify(doc));
  const agenda = new Agenda({ turns: 100, rounds: 100, queuedEvents: 100 });
  const trace = new SemanticTrace({}, 100000);
  const transport = new DocumentTransport(agenda, scenario, trace, 10, {
    consumeExecutionTurn() {},
    async command() {},
    receipt() {},
  });
  transport.register({
    actor: doc.actors[0].id,
    session: "p",
    generation: 1,
    runtimeGeneration: 1,
    open: true,
    attached: true,
  });
  assert.throws(
    () =>
      transport.effect(
        {
          kind: "control-receipt",
          session: "p",
          wire: JSON.stringify({
            ...watermark(),
            status: "failed",
            reason: "processingFailure",
            version: null,
            changedViews: [],
          }),
        },
        "request",
      ),
    /infrastructure-failed: progress processing failed/,
  );
  assert.equal(transport.pending(), 0);
  assert.deepEqual(transport.observed(doc.actors[0].id), []);
});
