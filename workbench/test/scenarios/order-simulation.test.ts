import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { liveClient } from "../support/live-client.js";
import { orderConfiguration } from "../../src/demos/orders/configuration.js";
import { startOrderProducer } from "../../src/demos/orders/producer.js";
import { orderTimeline } from "../../src/demos/orders/timeline.js";
import { startZooGlassSession } from "../../src/service/zooglass-session.js";

async function read(base: string, entity = "order-1", view = "order-summary") {
  const reply = await fetch(`${base}/views/${view}/${entity}`, {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(reply.status, 200);
  return reply.json();
}

async function waitForStale(base: string) {
  const end = Date.now() + 18000;
  while (Date.now() < end) {
    const state = await read(base);
    if (
      state.status.fields.inventory.freshness === "stale" &&
      state.status.fields.delivery.freshness === "stale"
    )
      return state;
    await delay(50);
  }
  throw new Error("Inventory and primary delivery did not become stale.");
}

test(
  "configured Order views reconcile independent inputs, priority and progress across three cycles",
  { timeout: 65000 },
  async () => {
    const service = await startZooGlassSession({
      configuration: orderConfiguration(),
    });
    let producer: Awaited<ReturnType<typeof startOrderProducer>> | undefined;
    let beforeDiagnostic: unknown;
    try {
      producer = await startOrderProducer(service.baseUrl, {
        tickMs: 10,
        cycles: 3,
        signal: service.signal,
        async onStep({ tick }) {
          const cycle = Math.floor(tick / 36);
          const phase = tick % 36;
          const state = await read(service.baseUrl);
          if (phase === 1) {
            assert.equal(state.data.order.status, "accepted");
            assert.equal(state.data.payment.status, "authorised");
            assert.equal(state.provenance.payment.sourceEntityId, "payment-1");
            const tracking = await read(
              service.baseUrl,
              "order-1",
              "order-tracking",
            );
            if (cycle === 0) {
              assert.equal(tracking.status.publication, "waiting");
              assert.deepEqual(tracking.data, {});
              assert.deepEqual(tracking.provenance, {});
            } else {
              assert.equal(tracking.data.inventory.cycle, cycle);
              assert.equal(tracking.data.order.cycle, cycle + 1);
            }
          }
          if (phase === 2) {
            assert.equal(
              state.provenance.delivery.sourceId,
              cycle === 0 ? "courier-backup" : "courier-primary",
            );
          }
          if (phase === 3) {
            assert.equal(state.provenance.delivery.sourceId, "courier-primary");
            assert.deepEqual(state.publicationSequences.delivery, [
              cycle * 2 + 1,
            ]);
          }
          if (phase === 4 && cycle === 0) {
            assert.deepEqual(state.status.inputs.orders.missingRanges, [
              { from: 2, through: 2, status: "provisional" },
            ]);
          }
          if (phase === 5) {
            const tracking = await read(
              service.baseUrl,
              "order-1",
              "order-tracking",
            );
            assert.equal(tracking.status.publication, "ready");
            assert.equal(tracking.data.inventory.status, "reserved");
            assert.equal(tracking.data.payment, undefined);
            assert.equal(
              tracking.provenance.inventory.sourceEntityId,
              "reservation-1",
            );
          }
          if (phase === 6 || phase === 7) {
            assert.equal(state.data.order.status, "dispatched");
            assert.deepEqual(state.publicationSequences.order, [cycle * 3 + 3]);
            assert.deepEqual(state.status.inputs.orders.missingRanges, []);
          }
          if (phase === 12 && cycle === 0) {
            const second = await read(service.baseUrl, "order-2");
            assert.deepEqual(second.status.inputs.payments.missingRanges, [
              { from: 2, through: 2, status: "provisional" },
            ]);
            assert.equal(second.data.payment.status, "authorised");
          }
          if (phase === 28 && cycle === 0) {
            const stale = await waitForStale(service.baseUrl);
            assert.equal(stale.data.inventory.status, "reserved");
            assert.equal(stale.provenance.delivery.sourceId, "courier-primary");
            const sixth = await read(service.baseUrl, "order-6");
            assert.equal(sixth.data.order.status, "cancelled");
            assert.equal(sixth.data.payment.status, "refunded");
          }
          if ((phase === 29 || phase === 31) && cycle === 0) {
            assert.equal(
              state.status.fields.inventory.freshness,
              "stale",
              "socket reconnect cannot refresh a value",
            );
            assert.equal(
              state.status.fields.delivery.freshness,
              "stale",
              "backup cannot refresh primary",
            );
          }
          if (phase === 32)
            assert.equal(state.status.fields.inventory.freshness, "fresh");
          if (phase === 33)
            assert.equal(state.status.fields.delivery.freshness, "fresh");
          if (phase === 34) {
            for (let i = 1; i <= 6; i++) {
              const snapshot = await read(service.baseUrl, `order-${i}`);
              assert.equal(snapshot.data.inventory.cycle, cycle + 1);
              assert.equal(
                snapshot.data.payment.status,
                i === 3 ? "declined" : i === 6 ? "refunded" : "authorised",
              );
              assert.equal(
                snapshot.status.inputs.orders.completeness,
                "completeThrough",
              );
              assert.equal(
                snapshot.status.inputs.inventory.completeness,
                "completeThrough",
              );
              assert.deepEqual(
                snapshot.status.inputs.payments.missingRanges,
                i === 2 ? [{ from: 2, through: 2, status: "confirmed" }] : [],
              );
            }
            beforeDiagnostic = state;
          }
          if (phase === 35 && cycle === 0) {
            assert.deepEqual(
              state,
              beforeDiagnostic,
              "unmapped target leaves existing snapshot unchanged",
            );
            assert.deepEqual(
              (await read(service.baseUrl, "payment-unmapped")).data,
              {},
            );
            assert.equal(
              (await read(service.baseUrl, "payment-unmapped")).version,
              0,
            );
          }
        },
      });
      await producer.done;

      // With sources stopped, a late subscriber must still receive the retained view.
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
        const retained = await read(
          service.baseUrl,
          "order-6",
          "order-tracking",
        );
        assert.deepEqual(snapshot.data, retained.data);
        assert.ok("provenance" in snapshot);
        assert.deepEqual(snapshot.provenance, retained.provenance);
        assert.equal(snapshot.version, retained.version);
      } finally {
        await viewer.close();
      }
    } finally {
      await producer?.close();
      await service.close();
    }
  },
);

test(
  "continuous schedule remains bounded beyond identity retention",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "order-bounds-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "state.sqlite");
    const service = await startZooGlassSession({
      configuration: orderConfiguration(),
      databasePath,
      signal: t.signal,
    });
    let producer: Awaited<ReturnType<typeof startOrderProducer>> | undefined;
    try {
      producer = await startOrderProducer(service.baseUrl, {
        tickMs: 10,
        cycles: 50,
        signal: service.signal,
      });
      await producer.done;
      for (let i = 1; i <= 6; i++) {
        const state = await read(service.baseUrl, `order-${i}`);
        assert.equal(state.data.order.cycle, 50);
        assert.equal(state.data.inventory.cycle, 50);
        for (const source of ["orders", "payments", "inventory"]) {
          const progress = state.status.inputs[source];
          assert.ok(progress.admissionFloor > 1 || source === "inventory");
          assert.equal(progress.sourceContractViolated, false);
          assert.ok(progress.missingRanges.length <= 1);
        }
        assert.deepEqual(
          state.status.inputs.payments.missingRanges,
          i === 2 ? [{ from: 2, through: 2, status: "expired" }] : [],
        );
      }
      // Release the service's exclusive store lock before inspecting its durable image.
      await service.close();
      // Inspect retained rows, not file size: SQLite pages/WAL are not live-state counts.
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const views = database
          .prepare("SELECT view, entity, state FROM views")
          .all();
        assert.equal(views.length, 12);
        assert.equal(new Set(views.map((row) => row.entity)).size, 6);
        for (const row of views) {
          assert.match(String(row.entity), /^order-[1-6]$/);
          assert.ok(
            ["order-summary", "order-tracking"].includes(String(row.view)),
          );
          const state = JSON.parse(String(row.state));
          assert.equal(
            Object.keys(state.data).length,
            row.view === "order-summary" ? 4 : 3,
          );
          assert.equal(Object.keys(state.candidates.delivery).length, 2);
          for (const [field, candidates] of Object.entries(state.candidates))
            assert.equal(
              Object.keys(candidates as object).length,
              field === "delivery" ? 2 : 1,
            );
        }
        const streams = database
          .prepare("SELECT source, entity, state FROM streams")
          .all();
        assert.equal(
          streams.length,
          31,
          "30 fixed source keys plus the unmapped diagnostic",
        );
        for (const row of streams) {
          const state = JSON.parse(String(row.state));
          assert.ok(Object.keys(state.receipts).length <= 128);
          if (state.progress) assert.ok(state.progress.received.length <= 2);
        }
      } finally {
        database.close();
      }
    } finally {
      await producer?.close();
      await service.close();
    }
  },
);

test("finite schedule has one permanent loss, exact retries and bounded work", () => {
  const timeline = orderTimeline(0, 1000);
  assert.equal(timeline.length, 36);
  assert.equal(
    timeline
      .flatMap((step) => step.actions)
      .filter((action) => action.kind === "omit").length,
    1,
  );
  assert.ok(timeline.every((step) => step.actions.length <= 18));
  const events = timeline.flatMap((step) =>
    step.actions.flatMap((action) =>
      action.kind === "publish" ? [action.event] : [],
    ),
  );
  const orders = events.filter(
    (event) => event.sourceId === "orders" && event.entityId === "order-1",
  );
  assert.deepEqual(
    orders.map((event) => event.publicationSequence),
    [1, 3, 2, 3],
  );
  assert.deepEqual(orders[1], orders[3]);
});

test(
  "producer restart against retained identities fails visibly",
  { timeout: 40000 },
  async () => {
    const service = await startZooGlassSession({
      configuration: orderConfiguration(),
    });
    try {
      const first = await startOrderProducer(service.baseUrl, {
        tickMs: 10,
        cycles: 1,
      });
      try {
        await first.done;
      } finally {
        await first.close();
      }
      const before = await read(service.baseUrl);
      const restarted = await startOrderProducer(service.baseUrl, {
        tickMs: 10,
        cycles: 1,
      });
      try {
        await assert.rejects(restarted.done, /identityConflict/);
        assert.deepEqual(await read(service.baseUrl), before);
      } finally {
        await restarted.close();
      }
    } finally {
      await service.close();
    }
  },
);
