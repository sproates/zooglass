import assert from "node:assert/strict";
import test from "node:test";
import { orderConfiguration } from "../../src/demos/orders/configuration.js";
import { startZooGlassSession } from "../../src/service/zooglass-session.js";
import { connectClient, closeClient } from "../../src/execution/sockets.js";
import { publishAndCheckReceipt } from "../../src/execution/publication-receipt.js";

test(
  "another Order entity, source and view use startup configuration without a new projection",
  { timeout: 30000 },
  async (t) => {
    const configuration = orderConfiguration();
    // A seventh order needs lookup keys where source IDs differ from the order ID.
    for (const view of configuration.views) {
      const inventory = view.entities!.inventory;
      assert.equal(inventory.mode, "lookupEntity");
      if (inventory.mode === "lookupEntity")
        inventory.keys["reservation-7"] = "order-7";
      if (view.publication?.mode === "requireContributions")
        view.publication.maxPendingEntities = 7;
    }
    configuration.sources.push({ id: "packing", epoch: "run" });
    configuration.views.push({
      id: "order-dispatch",
      entities: {
        orders: { mode: "envelopeEntity" },
        packing: { mode: "lookupEntity", keys: { "parcel-7": "order-7" } },
      },
      fields: {
        order: {
          sourceId: "orders",
          type: "order.state",
          mode: "latestBySequence",
        },
        packing: {
          sourceId: "packing",
          type: "packing.state",
          mode: "latestBySequence",
        },
      },
      publication: {
        mode: "requireContributions",
        fields: ["order", "packing"],
        maxPendingEntities: 7,
      },
    });
    const service = await startZooGlassSession({
      configuration,
      signal: t.signal,
    });
    let source: WebSocket | undefined;
    async function read(view: string) {
      const response = await fetch(`${service.baseUrl}/views/${view}/order-7`, {
        signal: AbortSignal.any([t.signal, AbortSignal.timeout(3000)]),
      });
      assert.equal(response.status, 200);
      return response.json();
    }
    async function publish(
      sourceId: string,
      entityId: string,
      type: string,
      payload: object,
    ) {
      return publishAndCheckReceipt(
        source!,
        {
          sourceId,
          epoch: "run",
          entityId,
          type,
          publicationSequence: 1,
          payload,
        },
        service.signal,
      );
    }
    try {
      source = await connectClient(
        service.baseUrl.replace("http:", "ws:") + "/events",
        service.signal,
        false,
      );
      const order = { status: "accepted", reference: "EXTRA-7" };
      await publish("orders", "order-7", "order.state", order);
      assert.deepEqual((await read("order-summary")).data, { order });
      for (const view of ["order-tracking", "order-dispatch"]) {
        const waiting = await read(view);
        assert.equal(waiting.status.publication, "waiting");
        assert.deepEqual(waiting.data, {});
      }
      const inventory = { status: "reserved" };
      await publish("inventory", "reservation-7", "inventory.state", inventory);
      const summary = await read("order-summary");
      const tracking = await read("order-tracking");
      assert.deepEqual(tracking.data, { order, inventory });
      assert.equal(
        tracking.provenance.inventory.sourceEntityId,
        "reservation-7",
      );
      const packing = { status: "packed" };
      const receipt = await publish(
        "packing",
        "parcel-7",
        "packing.state",
        packing,
      );
      assert.deepEqual(
        receipt.targets?.map((target) => [
          target.viewId,
          target.entityId,
          target.status,
        ]),
        [["order-dispatch", "order-7", "accepted"]],
      );
      const dispatch = await read("order-dispatch");
      assert.equal(dispatch.status.publication, "ready");
      assert.deepEqual(dispatch.data, { order, packing });
      assert.equal(dispatch.provenance.packing.sourceEntityId, "parcel-7");
      assert.deepEqual(dispatch.publicationSequences, {
        order: [1],
        packing: [1],
      });
      assert.deepEqual((await read("order-summary")).data, summary.data);
      assert.deepEqual((await read("order-tracking")).data, tracking.data);
    } finally {
      try {
        await closeClient(source);
      } finally {
        await service.close();
      }
    }
  },
);
