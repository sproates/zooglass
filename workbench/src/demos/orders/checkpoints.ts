import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { DemoState } from "../../control/demo-controller.js";
import type { PreparedCheckpoint } from "../../control/prepared-checkpoints.js";

export interface OrderCheckpointRun {
  signal: AbortSignal;
  baseUrl: string;
  advance(through: number): Promise<void>;
  close(): Promise<void>;
  publish(state: DemoState): void;
}
interface Snapshot {
  data: Record<string, { status: string; cycle: number }>;
  provenance: Record<string, { sourceId: string; sourceEntityId: string }>;
  publicationSequences: Record<string, number[]>;
  status: {
    publication: string;
    fields: Record<string, { freshness: string }>;
    inputs: Record<
      string,
      { missingRanges: { from: number; through: number; status: string }[] }
    >;
  };
}
async function read(
  run: OrderCheckpointRun,
  signal: AbortSignal,
  view = "order-summary",
  id = "order-1",
): Promise<Snapshot> {
  const response = await fetch(`${run.baseUrl}/views/${view}/${id}`, {
    signal: AbortSignal.any([signal, run.signal, AbortSignal.timeout(3000)]),
  });
  if (!response.ok)
    throw new Error(`Snapshot request failed: ${response.status}`);
  return response.json();
}
const values = (snapshot: Snapshot) => ({
  data: snapshot.data,
  provenance: snapshot.provenance,
  publicationSequences: snapshot.publicationSequences,
});

/** Independent expected outcomes, never derived from the timeline or a reducer. */
export const orderCheckpoints: PreparedCheckpoint<OrderCheckpointRun>[] = [
  checkpoint(
    0,
    "Order received; tracking waits for stock",
    async (run, signal) => {
      assert.equal((await read(run, signal)).data.order.status, "accepted");
      const tracking = await read(run, signal, "order-tracking");
      assert.equal(tracking.status.publication, "waiting");
      assert.deepEqual(tracking.data, {});
      assert.deepEqual(tracking.provenance, {});
    },
  ),
  checkpoint(1, "Payment maps from its own reference", async (run, signal) => {
    const snapshot = await read(run, signal);
    assert.equal(snapshot.data.payment.status, "authorised");
    assert.equal(snapshot.provenance.payment.sourceEntityId, "payment-1");
  }),
  checkpoint(2, "Backup courier reports first", async (run, signal) => {
    const snapshot = await read(run, signal);
    assert.equal(snapshot.provenance.delivery.sourceId, "courier-backup");
    assert.deepEqual(snapshot.publicationSequences.delivery, [20]);
  }),
  checkpoint(3, "Primary courier takes priority", primary),
  checkpoint(
    4,
    "Dispatch overtakes a missing packing report",
    async (run, signal) => {
      const snapshot = await read(run, signal);
      assert.equal(snapshot.data.order.status, "dispatched");
      assert.deepEqual(snapshot.status.inputs.orders.missingRanges, [
        { from: 2, through: 2, status: "provisional" },
      ]);
    },
  ),
  checkpoint(5, "Stock releases the tracking view", async (run, signal) => {
    const snapshot = await read(run, signal, "order-tracking");
    assert.equal(snapshot.status.publication, "ready");
    assert.equal(snapshot.data.inventory.status, "reserved");
    assert.equal(snapshot.data.order.status, "dispatched");
    assert.equal(snapshot.data.payment, undefined);
  }),
  checkpoint(
    6,
    "Late packing closes the gap without replacing dispatch",
    async (run, signal) => {
      const snapshot = await read(run, signal);
      assert.equal(snapshot.data.order.status, "dispatched");
      assert.deepEqual(snapshot.status.inputs.orders.missingRanges, []);
    },
  ),
  unchanged(7, "Exact dispatch retry has no additional effect"),
  checkpoint(
    12,
    "Order 2 has a missing payment report",
    async (run, signal) => {
      const snapshot = await read(run, signal, "order-summary", "order-2");
      assert.deepEqual(snapshot.publicationSequences.payment, [3]);
      assert.deepEqual(snapshot.status.inputs.payments.missingRanges, [
        { from: 2, through: 2, status: "provisional" },
      ]);
      await primary(run, signal);
    },
  ),
  checkpoint(
    24,
    "Stock source disconnects; other sources remain active",
    async (run, signal) => {
      assert.equal(
        (await read(run, signal, "order-summary", "order-6")).data.inventory
          .status,
        "reserved",
      );
    },
  ),
  checkpoint(
    26,
    "Orders and payments continue; wait for stock and courier to become stale",
    async (run, signal) => {
      const last = await read(run, signal, "order-summary", "order-6");
      assert.equal(last.data.order.status, "cancelled");
      assert.equal(last.data.payment.status, "refunded");
      const deadline = AbortSignal.any([
        signal,
        run.signal,
        AbortSignal.timeout(20000),
      ]);
      while (true) {
        deadline.throwIfAborted();
        const snapshot = await read(run, deadline);
        if (
          snapshot.status.fields.inventory.freshness === "stale" &&
          snapshot.status.fields.delivery.freshness === "stale"
        )
          break;
        await delay(50, undefined, { signal: deadline });
      }
    },
  ),
  checkpoint(
    29,
    "Fresh backup cannot displace the stale primary",
    async (run, signal) => {
      await primary(run, signal);
      assert.equal(
        (await read(run, signal)).status.fields.delivery.freshness,
        "stale",
      );
    },
  ),
  checkpoint(
    31,
    "Stock reconnects; connection alone does not refresh its report",
    async (run, signal) => {
      assert.equal(
        (await read(run, signal)).status.fields.inventory.freshness,
        "stale",
      );
    },
  ),
  checkpoint(
    32,
    "A new stock report refreshes the retained value",
    async (run, signal) => {
      const snapshot = await read(run, signal);
      assert.equal(snapshot.status.fields.inventory.freshness, "fresh");
      assert.deepEqual(snapshot.publicationSequences.inventory, [2]);
    },
  ),
  checkpoint(33, "Primary courier confirms delivery", async (run, signal) => {
    const snapshot = await read(run, signal);
    assert.equal(snapshot.data.delivery.status, "delivered");
    assert.equal(snapshot.status.fields.delivery.freshness, "fresh");
  }),
  checkpoint(
    34,
    "Watermarks confirm the missing payment delivery",
    async (run, signal) => {
      const snapshot = await read(run, signal, "order-summary", "order-2");
      assert.deepEqual(snapshot.status.inputs.payments.missingRanges, [
        { from: 2, through: 2, status: "confirmed" },
      ]);
    },
  ),
  unchanged(
    35,
    "Unmapped payment is rejected for the view; orders remain unchanged",
  ),
];
async function primary(run: OrderCheckpointRun, signal: AbortSignal) {
  const snapshot = await read(run, signal);
  assert.equal(snapshot.provenance.delivery.sourceId, "courier-primary");
  assert.deepEqual(snapshot.publicationSequences.delivery, [1]);
}
function checkpoint(
  through: number,
  label: string,
  check: (run: OrderCheckpointRun, signal: AbortSignal) => Promise<void>,
): PreparedCheckpoint<OrderCheckpointRun> {
  return {
    id: `order-${through}`,
    label,
    async execute(run, signal) {
      await run.advance(through);
      signal.throwIfAborted();
      await check(run, signal);
    },
  };
}
function unchanged(
  through: number,
  label: string,
): PreparedCheckpoint<OrderCheckpointRun> {
  return {
    id: `order-${through}`,
    label,
    async execute(run, signal) {
      const before = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          read(run, signal, "order-summary", `order-${i + 1}`),
        ),
      );
      await run.advance(through);
      for (let i = 0; i < 6; i++) {
        const after = await read(
          run,
          signal,
          "order-summary",
          `order-${i + 1}`,
        );
        // The retry checkpoint also delivers unrelated sources for other slots.
        if (through === 7 && i !== 0) continue;
        assert.deepEqual(values(after), values(before[i]));
      }
    },
  };
}
