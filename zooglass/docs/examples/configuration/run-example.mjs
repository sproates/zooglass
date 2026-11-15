// Node 26; run against the matching configuration and a fresh service/store.
import assert from "node:assert/strict";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

export async function runExample(mode, baseUrl = "http://127.0.0.1:8080") {
  assert.ok(
    ["orders", "sales", "sales-restart"].includes(mode),
    "Choose orders, sales or sales-restart",
  );
  const endpoint = new URL("/events", baseUrl);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(endpoint);
  const snapshot = async (viewId, entityId) => {
    const url = new URL("/views", baseUrl);
    url.search = new URLSearchParams({ viewId, entityId }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const send = async (event, status) => {
    const reply = once(socket, "message", {
      signal: AbortSignal.timeout(5000),
    });
    socket.send(JSON.stringify(event));
    const receipt = JSON.parse((await reply)[0].data);
    assert.equal(receipt.status, status);
    return receipt;
  };
  try {
    await once(socket, "open", { signal: AbortSignal.timeout(5000) });
    if (mode === "orders") {
      const event = (
        sourceId,
        sourceEntityId,
        publicationSequence,
        payload,
        type = "updated",
      ) => ({
        sourceId,
        epoch: "run",
        sourceEntityId,
        publicationSequence,
        type,
        payload,
      });
      const order = event("orders", "order-42", 1, { state: "placed" });
      await send(order, "applied");
      assert.deepEqual((await snapshot("order-summary", "order-42")).data, {});
      await send(
        event("payments", "payment-9", 1, { state: "paid" }),
        "applied",
      );
      await send(
        event(
          "courier-backup",
          "order-42",
          900,
          { state: "in transit" },
          "status",
        ),
        "applied",
      );
      const backup = await snapshot("order-summary", "order-42");
      assert.deepEqual(backup.data.delivery, { state: "in transit" });
      assert.equal(backup.provenance.delivery.sourceId, "courier-backup");
      await send(
        event(
          "courier-primary",
          "order-42",
          2,
          { state: "delivered" },
          "status",
        ),
        "applied",
      );
      await send(order, "duplicate");
      const result = await snapshot("order-summary", "order-42");
      assert.deepEqual(result.data, {
        order: { state: "placed" },
        payment: { state: "paid" },
        delivery: { state: "delivered" },
      });
      assert.equal(result.provenance.payment.sourceEntityId, "payment-9");
      assert.equal(result.provenance.delivery.sourceId, "courier-primary");
      return result;
    }
    const sale = (
      publicationSequence,
      birthSequence,
      revision,
      operation,
      payload,
    ) => ({
      sourceId: "sales",
      epoch: "day-1",
      sourceEntityId: "shop-1",
      publicationSequence,
      type: "sale",
      fact: { birthSequence, revision, operation },
      payload,
    });
    const withdrawn = sale(4, 1, 3, "retract", {});
    if (mode === "sales") {
      await send(sale(1, 1, 1, "create", { amount: 12 }), "committed");
      await send(sale(2, 1, 2, "revise", { amount: 15 }), "committed");
      assert.equal((await snapshot("sales-summary", "shop-1")).data.total, 15);
      await send(sale(3, 3, 1, "create", { amount: 5 }), "committed");
      await send(withdrawn, "committed");
    } else {
      const receipt = await send(withdrawn, "duplicate");
      assert.equal(receipt.reason, "alreadyCommitted");
    }
    const result = await snapshot("sales-summary", "shop-1");
    assert.deepEqual(result.data, {
      items: [{ birthSequence: 3, revision: 1, payload: { amount: 5 } }],
      total: 5,
    });
    return result;
  } finally {
    if (socket.readyState === WebSocket.OPEN) {
      const closed = once(socket, "close", {
        signal: AbortSignal.timeout(5000),
      });
      socket.close();
      await closed;
    } else {
      socket.close();
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await runExample(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(result, null, 2));
}
