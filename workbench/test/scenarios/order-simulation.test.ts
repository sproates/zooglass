import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { orderViews } from "../../src/demos/orders/contracts.js";
import { startOrderProducer } from "../../src/demos/orders/producer.js";
import { orderTimeline } from "../../src/demos/orders/timeline.js";
import { startZooGlassSession } from "../../src/service/zooglass-session.js";
import { liveClient } from "../support/live-client.js";

type Fact = {
  sequence: number;
  cycle: number;
  status: string;
  observedAt: number;
};
type State = { order?: Fact; payment?: Fact; inventory?: Fact };

async function read(
  baseUrl: string,
  id: string,
  view = "order-summary",
): Promise<State> {
  const response = await fetch(`${baseUrl}/views/${view}/${id}`, {
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 200);
  return (await response.json()).data;
}

async function waitFor(
  baseUrl: string,
  id: string,
  field: keyof State,
  sequence: number,
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/views/order-summary/${id}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      const state = (await response.json()).data as State;
      if (state[field]?.sequence === sequence) return state;
    }
    await delay(10);
  }
  throw new Error(`Missing processing barrier: ${id}.${field}=${sequence}`);
}

test(
  "order sources compose and reconcile three cycles through real ZooGlass",
  { timeout: 40000 },
  async () => {
    const service = await startZooGlassSession({ views: orderViews });
    let producer: Awaited<ReturnType<typeof startOrderProducer>> | undefined;
    const checkpoints: number[] = [];
    try {
      producer = await startOrderProducer(service.baseUrl, {
        tickMs: 10,
        cycles: 3,
        signal: service.signal,
        async onStep({ tick }) {
          const cycle = Math.floor(tick / 36);
          const phase = tick % 36;
          const base = cycle * 10;
          if (phase === 1) {
            await waitFor(service.baseUrl, "order-1", "order", base + 1);
            const state = await waitFor(
              service.baseUrl,
              "order-1",
              "payment",
              base + 1,
            );
            assert.equal(state.order?.status, "accepted");
            assert.equal(state.payment?.status, "authorised");
            if (cycle === 0)
              assert.equal(
                state.inventory,
                undefined,
                "unknown is not failure",
              );
            else
              assert.equal(
                state.inventory?.cycle,
                cycle,
                "previous-cycle contribution is retained honestly",
              );
          }
          if (phase === 3 && cycle > 0) {
            // This newer event is on the same orders socket, after the old-cycle delivery.
            await waitFor(service.baseUrl, "order-2", "order", base + 1);
            assert.equal(
              (await read(service.baseUrl, "order-1")).order?.sequence,
              base + 1,
            );
          }
          if (phase === 5) {
            const state = await waitFor(
              service.baseUrl,
              "order-1",
              "inventory",
              base + 1,
            );
            await waitFor(service.baseUrl, "order-1", "order", base + 3);
            assert.equal(state.inventory?.status, "reserved");
            assert.equal(state.payment?.sequence, base + 1);
          }
          if (phase === 6) {
            // order-3 acceptance follows the delayed order-1 report on the orders socket.
            // Check before the duplicate could hide an erroneous rollback.
            await waitFor(service.baseUrl, "order-3", "order", base + 1);
            const state = await read(service.baseUrl, "order-1");
            assert.equal(state.order?.sequence, base + 3);
            assert.equal(state.order?.status, "dispatched");
          }
          if (phase === 7) {
            // order-2 dispatch follows order-1's delayed and duplicate reports on the same socket.
            await waitFor(service.baseUrl, "order-2", "order", base + 3);
            const state = await read(service.baseUrl, "order-1");
            assert.equal(state.order?.sequence, base + 3);
            assert.equal(state.order?.status, "dispatched");
            assert.ok(state.inventory!.observedAt < state.order!.observedAt);
          }
          if (phase === 9) {
            const state = await waitFor(
              service.baseUrl,
              "order-1",
              "payment",
              base + 3,
            );
            assert.equal(state.payment?.status, "authorised");
            assert.equal(state.order?.sequence, base + 3);
          }
          if (phase === 26) {
            await waitFor(service.baseUrl, "order-6", "order", base + 4);
            const state = await waitFor(
              service.baseUrl,
              "order-6",
              "payment",
              base + 4,
            );
            assert.equal(state.order?.status, "cancelled");
            assert.equal(state.payment?.status, "refunded");
            assert.equal(
              state.inventory?.sequence,
              base + 1,
              "inventory is retained during its outage",
            );
          }
          if (phase === 28) {
            await waitFor(service.baseUrl, "order-6", "inventory", base + 3);
            for (let i = 1; i <= 6; i++) {
              const state = await read(service.baseUrl, `order-${i}`);
              assert.equal(
                state.order?.status,
                i === 3 || i === 6 ? "cancelled" : "dispatched",
              );
              assert.equal(
                state.payment?.status,
                i === 3 ? "declined" : i === 6 ? "refunded" : "authorised",
              );
              assert.equal(
                state.inventory?.status,
                i === 3 ? "unavailable" : i === 6 ? "released" : "reserved",
              );
              for (const fact of Object.values(state))
                assert.equal(fact.cycle, cycle + 1);
              assert.deepEqual(
                await read(service.baseUrl, `order-${i}`, "order-tracking"),
                {
                  order: state.order,
                  inventory: state.inventory,
                },
              );
            }
            checkpoints.push(cycle);
          }
        },
      });
      await producer.done;
      assert.deepEqual(checkpoints, [0, 1, 2]);

      // No producers remain. A late subscription must deliver retained state immediately.
      const viewer = await liveClient(service.baseUrl);
      try {
        await viewer.send({
          action: "subscribe",
          viewId: "order-tracking",
          entityId: "order-6",
        });
        assert.equal((await viewer.next()).type, "subscribed");
        const snapshot = await viewer.next();
        assert.equal(snapshot.type, "view-update");
        assert.deepEqual(
          snapshot.data,
          await read(service.baseUrl, "order-6", "order-tracking"),
        );
      } finally {
        await viewer.close();
      }
    } finally {
      await producer?.close();
      await service.close();
    }
  },
);

test("finite order timeline has bounded actions, explicit faults and no payment revision 2", () => {
  const timeline = orderTimeline(0, 1000);
  assert.equal(timeline.length, 36);
  assert.equal(
    timeline
      .flatMap((step) => step.actions)
      .filter((action) => action.kind === "omit").length,
    12,
  );
  assert.equal(timeline[24].actions.at(-1)?.kind, "disconnect");
  assert.equal(timeline[28].actions[0].kind, "reconnect");
  const events = timeline.flatMap((step) =>
    step.actions.flatMap((action) =>
      action.kind === "publish" ? [action.event] : [],
    ),
  );
  assert.equal(new Set(events.map((event) => event.entityId)).size, 6);
  assert.equal(
    events.some(
      (event) => event.sourceId === "payments" && event.payload.sequence === 2,
    ),
    false,
  );
  const orders = events.filter(
    (event) => event.entityId === "order-1" && event.sourceId === "orders",
  );
  assert.deepEqual(
    orders.map((event) => event.payload.sequence),
    [1, 3, 2, 3],
  );
  assert.deepEqual(
    orders[1],
    orders[3],
    "duplicate is the original report including observation time",
  );
});
