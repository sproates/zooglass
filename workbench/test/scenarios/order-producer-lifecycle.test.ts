import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { WebSocketServer } from "ws";
import { startOrderProducer } from "../../src/demos/orders/producer.js";

async function sourceServer(t: TestContext) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const connections: { source?: string; messages: number }[] = [];
  const closures: Promise<unknown>[] = [];
  server.on("connection", (socket) => {
    closures.push(once(socket, "close", { signal: AbortSignal.timeout(5000) }));
    const record = { source: undefined as string | undefined, messages: 0 };
    connections.push(record);
    socket.on("message", (bytes) => {
      const event = JSON.parse(String(bytes));
      record.source ??= event.sourceId;
      assert.equal(
        event.sourceId,
        record.source,
        "sources own separate sockets",
      );
      record.messages++;
    });
  });
  await once(server, "listening");
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    connections,
    closed: () => Promise.all(closures),
    inventoryClosed: () => closures[2],
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

test("finite order producer reconnects inventory on a new socket and releases every connection", async (t) => {
  const host = await sourceServer(t);
  const producer = await startOrderProducer(host.baseUrl, {
    tickMs: 10,
    cycles: 1,
    async onStep({ tick }) {
      if (tick === 26) {
        await host.inventoryClosed();
        assert.equal(host.server.clients.size, 2);
      }
    },
  });
  t.after(() => producer.close());
  await producer.done;
  assert.deepEqual(
    host.connections.map((connection) => connection.source).sort(),
    ["inventory", "inventory", "orders", "payments"],
  );
  await host.closed();
  assert.equal(host.server.clients.size, 0);
});

test("infinite order producer can be closed during its delay", async (t) => {
  const host = await sourceServer(t);
  const producer = await startOrderProducer(host.baseUrl, { tickMs: 10000 });
  await producer.close();
  await assert.rejects(producer.done);
  await producer.close();
  await host.closed();
  assert.equal(host.server.clients.size, 0);
});

test("checkpoint failure rejects done and closes all source sockets", async (t) => {
  const host = await sourceServer(t);
  const producer = await startOrderProducer(host.baseUrl, {
    tickMs: 10,
    onStep() {
      throw new Error("checkpoint failed");
    },
  });
  await assert.rejects(producer.done, /checkpoint failed/);
  await host.closed();
  assert.equal(host.server.clients.size, 0);
  await producer.close();
});

test("invalid timing and cycle limits fail before opening a source", async () => {
  for (const options of [
    { tickMs: 0 },
    { tickMs: NaN },
    { cycles: 0 },
    { cycles: 1.5 },
  ])
    await assert.rejects(
      startOrderProducer("http://127.0.0.1:1", options),
      /must be/,
    );
});
