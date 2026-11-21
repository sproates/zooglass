import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { Connections } from "../src/benchmark/connections.js";

for (const [message, error] of [
  ["invalid", /JSON/],
  ['{"value":1}', /oracle mismatch/],
] as const) {
  test(`connection retains callback failure for ${message}`, async (t) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    t.after(() => {
      for (const socket of server.clients) socket.terminate();
      server.close();
    });
    const connections = new Connections(new AbortController().signal);
    t.after(() => connections.close());
    const port = (server.address() as { port: number }).port;
    const peer = once(server, "connection");
    const socket = await connections.open(`ws://127.0.0.1:${port}`, () => {
      throw new Error("oracle mismatch");
    });
    const [remote] = await peer;
    const received = once(socket, "message");
    remote.send(message);
    await received;
    assert.throws(() => connections.check(), error);
  });
}

test("connection cancellation rejects handshake and owner can close pending sockets", async (t) => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const connections = new Connections(controller.signal);
  t.after(() => connections.close());
  await assert.rejects(
    connections.open("ws://127.0.0.1:1", () => {}),
    /cancelled/,
  );
});

test("receive timestamp precedes decoding the message", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(() => server.close());
  const connections = new Connections(new AbortController().signal);
  t.after(() => connections.close());
  const port = (server.address() as { port: number }).port;
  let atMs = Infinity;
  const peer = once(server, "connection");
  const socket = await connections.open(
    `ws://127.0.0.1:${port}`,
    (_, receivedMs) => {
      atMs = receivedMs;
    },
  );
  const [remote] = await peer;
  const received = once(socket, "message");
  let parseStarted = 0;
  const original = JSON.parse;
  t.mock.method(JSON, "parse", (input: string) => {
    parseStarted = performance.now();
    return original(input);
  });
  remote.send("{}");
  await received;
  assert.ok(atMs <= parseStarted, `${atMs} > ${parseStarted}`);
});
