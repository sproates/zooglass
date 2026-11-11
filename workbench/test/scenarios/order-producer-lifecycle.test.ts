import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { WebSocketServer } from "ws";
import { startOrderProducer } from "../../src/demos/orders/producer.js";

type Failure =
  | "target"
  | "progress"
  | "retry"
  | "previous-cycle retry"
  | "duplicate reason"
  | "unmapped entity";

async function sourceServer(t: TestContext, failure?: Failure) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const connections: { source?: string; messages: number }[] = [];
  const closures: Promise<unknown>[] = [];
  const publications = new Map<string, number>();
  server.on("connection", (socket, request) => {
    const progress = request.url === "/progress";
    closures.push(once(socket, "close", { signal: AbortSignal.timeout(5000) }));
    const record = { source: undefined as string | undefined, messages: 0 };
    connections.push(record);
    socket.on("message", (bytes) => {
      const event = JSON.parse(String(bytes));
      record.source ??= progress ? "progress" : event.sourceId;
      assert.equal(
        progress ? "progress" : event.sourceId,
        record.source,
        "sources own separate sockets",
      );
      record.messages++;
      const { sourceId, epoch, sourceEntityId, publicationSequence } = event;
      const identity = JSON.stringify([
        sourceId,
        epoch,
        sourceEntityId,
        publicationSequence,
      ]);
      const count = progress ? 0 : (publications.get(identity) ?? 0) + 1;
      if (!progress) publications.set(identity, count);
      const duplicate = count > 1;
      const wrongCommit =
        (failure === "retry" && count === 2) ||
        (failure === "previous-cycle retry" && count === 3);
      const status =
        progress && failure === "progress"
          ? "rejected"
          : duplicate && !wrongCommit
            ? "duplicate"
            : "committed";
      const reason =
        status === "duplicate" && failure !== "duplicate reason"
          ? "alreadyCommitted"
          : "sqlite";
      const unmapped = sourceEntityId === "payment-unmapped";
      socket.send(
        JSON.stringify({
          status,
          reason,
          ...(progress
            ? { kind: "watermark", throughSequence: event.throughSequence }
            : {
                targets: [
                  {
                    viewId: "order-summary",
                    entityId:
                      unmapped && failure !== "unmapped entity"
                        ? null
                        : event.sourceEntityId,
                    status:
                      event.sourceEntityId === "payment-unmapped" ||
                      failure === "target"
                        ? "rejected"
                        : "accepted",
                    reason:
                      event.sourceEntityId === "payment-unmapped"
                        ? "unknownEntityMapping"
                        : null,
                  },
                ],
              }),
          stream: { sourceId, epoch, sourceEntityId },
          publicationSequence,
        }),
      );
    });
  });
  await once(server, "listening");
  t.after(async () => {
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    connections,
    closed: () => Promise.all(closures),
    inventoryClosed: () => closures[3],
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
        assert.equal(host.server.clients.size, 5);
      }
    },
  });
  t.after(() => producer.close());
  await producer.done;
  assert.deepEqual(
    host.connections.map((connection) => connection.source).sort(),
    [
      "courier-backup",
      "courier-primary",
      "inventory",
      "inventory",
      "orders",
      "payments",
      "progress",
    ],
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
  ]) {
    await assert.rejects(
      startOrderProducer("http://127.0.0.1:1", options),
      /must be/,
    );
  }
});

for (const failure of ["target", "progress"] as const) {
  test(`unexpected ${failure} rejection fails the run and closes every socket`, async (t) => {
    const host = await sourceServer(t, failure);
    const producer = await startOrderProducer(host.baseUrl, {
      tickMs: 10,
      cycles: 1,
    });
    t.after(() => producer.close());
    await assert.rejects(
      producer.done,
      failure === "target"
        ? /Unexpected Order target rejection/
        : /Order progress rejected/,
    );
    await host.closed();
    assert.equal(host.server.clients.size, 0);
  });
}

for (const failure of [
  "retry",
  "previous-cycle retry",
  "duplicate reason",
  "unmapped entity",
] as const) {
  test(`incorrect ${failure} receipt fails the run and closes every socket`, async (t) => {
    const host = await sourceServer(t, failure);
    const producer = await startOrderProducer(host.baseUrl, {
      tickMs: 10,
      cycles: failure === "previous-cycle retry" ? 2 : 1,
    });
    t.after(() => producer.close());
    await assert.rejects(
      producer.done,
      failure === "unmapped entity"
        ? /unmapped summary target/
        : /Expected duplicate\/alreadyCommitted/,
    );
    await host.closed();
    assert.equal(host.server.clients.size, 0);
  });
}
