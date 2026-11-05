import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { startProducer } from "../../src/demos/vehicle/continuous/producer.js";
import { loadCars } from "../../src/demos/vehicle/continuous/journeys.js";

test("continuous producer sends faults in order, reconnects, and closes its sockets", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const observed = new EventEmitter();
  const positions: number[] = [];
  const notices: string[] = [];
  let connections = 0;
  const closures: Promise<unknown>[] = [];
  server.on("connection", (socket) => {
    connections++;
    closures.push(
      once(socket, "close", { signal: AbortSignal.timeout(15000) }),
    );
    socket.on("message", (bytes) => {
      const message = JSON.parse(String(bytes));
      assert.equal(message.sourceId, "fleet");
      assert.equal(message.sourceEntityId, "car-1");
      const { sourceId, epoch, sourceEntityId, publicationSequence } = message;
      const repeat =
        message.type === "position" &&
        positions.includes(message.payload.sequence);
      socket.send(
        JSON.stringify({
          status: repeat ? "duplicate" : "applied",
          stream: { sourceId, epoch, sourceEntityId },
          publicationSequence,
        }),
      );
      if (message.type === "position") {
        positions.push(message.payload.sequence);
        if (message.payload.sequence === 131) {
          observed.emit("complete");
        }
      } else {
        notices.push(message.payload.text);
      }
    });
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const completed = once(observed, "complete", {
    signal: AbortSignal.timeout(15000),
  });
  const cars = await loadCars();
  const producer = await startProducer(
    `http://127.0.0.1:${address.port}`,
    [cars[0]],
    { tickMs: 10 },
  );
  t.after(() => producer.close());
  await completed;
  await producer.close();
  await producer.close();
  await assert.rejects(producer.done, { name: "AbortError" });
  await Promise.all(closures);

  assert.deepEqual(positions.slice(8, 17), [9, 10, 12, 13, 14, 15, 11, 16, 17]);
  assert.equal(positions.filter((sequence) => sequence === 31).length, 2);
  assert.ok(!positions.includes(51));
  assert.ok(!positions.some((sequence) => sequence >= 71 && sequence <= 90));
  assert.ok(!positions.some((sequence) => sequence >= 111 && sequence <= 130));
  assert.ok(positions.includes(70) && positions.includes(91));
  assert.deepEqual(notices, [
    "delayed report sent after newer reports",
    "duplicate report sent",
    "one report permanently lost",
    "source disconnecting for 20 reports",
    "source reconnected",
    "stopped reporting; source remains connected",
    "reporting resumed",
  ]);
  assert.equal(connections, 2);
  assert.equal(server.clients.size, 0);
});

test("continuous producer rejects invalid timing before opening sockets", async () => {
  for (const tickMs of [0, 9, NaN, Infinity]) {
    await assert.rejects(startProducer("http://127.0.0.1:1", [], { tickMs }), {
      message: "Tick interval must be at least 10ms.",
    });
  }
});

test("a rejected car report fails the producer and releases its connections", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const closed: Promise<unknown>[] = [];
  try {
    server.on("connection", (socket) => {
      closed.push(once(socket, "close", { signal: AbortSignal.timeout(5000) }));
      socket.on("message", (bytes) => {
        const { sourceId, epoch, sourceEntityId, publicationSequence } =
          JSON.parse(String(bytes));
        socket.send(
          JSON.stringify({
            status: "rejected",
            reason: "identityConflict",
            stream: { sourceId, epoch, sourceEntityId },
            publicationSequence,
          }),
        );
      });
    });
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const producer = await startProducer(
      `http://127.0.0.1:${address.port}`,
      (await loadCars()).slice(0, 2),
      { tickMs: 10 },
    );
    const timer = setTimeout(() => void producer.close(), 2000);
    try {
      await assert.rejects(producer.done, /identityConflict/);
      await Promise.all(closed);
      assert.equal(server.clients.size, 0);
    } finally {
      clearTimeout(timer);
      await producer.close();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
