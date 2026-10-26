import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { openScenarioSession } from "../src/scenario-session.js";
import { playScenario } from "../src/playback.js";
import type { Scenario } from "../src/scenario.js";
import { localService, acceptWebSocket } from "./support/local-service.js";

const scenario: Scenario = {
  name: "Session ownership",
  sources: [],
  views: [],
  clients: [{ id: "viewer", name: "Viewer", initialState: "connected" }],
  timeline: [
    {
      kind: "client-subscription",
      simulationTime: 100,
      clientId: "viewer",
      action: "subscribe",
      viewId: "position",
      entityId: "bus",
    },
    {
      kind: "client-view-check",
      simulationTime: 200,
      clientId: "viewer",
      viewId: "position",
      entityId: "bus",
      expected: { position: 42 },
    },
    {
      kind: "client-state",
      simulationTime: 300,
      clientId: "viewer",
      state: "disconnected",
    },
  ],
};

test("client binding receives every client action and closes once", async (t) => {
  const seen: unknown[] = [];
  let closes = 0;
  const session = await openScenarioSession(scenario, "http://127.0.0.1:1", {
    createClientExecutor(client, url) {
      assert.equal(client.id, "viewer");
      assert.equal(url, "ws://127.0.0.1:1/views/live");

      return {
        async execute(entry) {
          seen.push(entry);
        },
        async close() {
          closes++;
        },
      };
    },
  });

  t.after(() => session.close());

  const trace = playScenario(scenario);

  for (const entry of trace) await session.execute(entry);

  assert.deepEqual(seen, trace);
  await Promise.all([session.close(), session.close()]);

  assert.equal(closes, 1);
  await assert.rejects(session.execute(trace[0]), /session closed/);
});

test("closing cancels an active executor, rejects overlap and waits before disposal", async (t) => {
  const order: string[] = [];
  const session = await openScenarioSession(scenario, "http://127.0.0.1:1", {
    createClientExecutor: () => ({
      async execute(_entry, signal) {
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              order.push("cancelled");
              reject(signal.reason);
            },
            { once: true },
          ),
        );
      },
      async close() {
        order.push("closed");
      },
    }),
  });

  t.after(() => session.close());

  const entry = playScenario(scenario)[0];
  const pending = session.execute(entry);
  const rejected = assert.rejects(pending, /session closed/);

  await assert.rejects(session.execute(entry), /already running/);
  await session.close();
  await rejected;

  assert.deepEqual(order, ["cancelled", "closed"]);
});

test("partial client setup closes previous executors, even when one close fails", async () => {
  const closed: string[] = [];

  await assert.rejects(
    openScenarioSession(
      {
        ...scenario,
        clients: ["a", "b", "c"].map((id) => ({
          id,
          name: id,
          initialState: "disconnected",
        })),
      },
      "http://127.0.0.1:1",
      {
        createClientExecutor(client) {
          if (client.id === "c") throw new Error("setup failed");

          return {
            async execute() {},
            async close() {
              closed.push(client.id);

              if (client.id === "a") throw new Error("close failed");
            },
          };
        },
      },
    ),
    /cleanup failed/,
  );
  assert.deepEqual(closed.sort(), ["a", "b"]);
});

test("closing cancels an HTTP view check before its timeout", async (t) => {
  let received!: () => void;
  const request = new Promise<void>((resolve) => {
    received = resolve;
  });
  const { baseUrl } = await localService(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"data":{}}');
    received();
  });
  const session = await openScenarioSession(
    { ...scenario, clients: [] },
    baseUrl,
  );

  t.after(() => session.close());

  const pending = session.execute({
    kind: "view-check",
    simulationTime: 0,
    viewId: "position",
    entityId: "bus",
    expected: { position: 42 },
  });
  const rejected = assert.rejects(pending);

  await request;
  await session.close();
  await rejected;
});

test("source startup failure closes earlier source connections", async (t) => {
  const { server, baseUrl } = await localService(t, (_req, res) => res.end());
  let connections = 0;
  let firstClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    firstClosed = resolve;
  });

  server.on("upgrade", (req, socket) => {
    t.after(() => socket.destroy());

    if (++connections === 2) {
      socket.destroy();
      return;
    }

    acceptWebSocket(req, socket);
    socket.on("close", firstClosed);
  });

  await assert.rejects(
    openScenarioSession(
      {
        ...scenario,
        clients: [],
        sources: [
          { id: "a", name: "A" },
          { id: "b", name: "B" },
        ],
      },
      baseUrl,
    ),
    /Could not connect/,
  );
  await closed;
});

test(
  "default Node executor cancels a pending view receipt and closes its socket",
  { timeout: 5_000 },
  async (t) => {
    const { server, baseUrl } = await localService(t, (_req, res) => res.end());
    let disconnected!: () => void;
    const closed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });

    server.on("upgrade", (req, socket) => {
      acceptWebSocket(req, socket);
      socket.on("close", disconnected);
    });

    const session = await openScenarioSession(scenario, baseUrl);

    t.after(() => session.close());
    await session.execute(playScenario(scenario)[0]);

    const pending = session.execute(playScenario(scenario)[2]);
    const rejected = assert.rejects(pending);

    await session.close();
    await rejected;
    await closed;
  },
);

test(
  "cancellation interrupts a socket handshake and cleans up the session",
  { timeout: 5_000 },
  async (t) => {
    const { server, baseUrl } = await localService(t, (_req, res) => res.end());
    const upgraded = once(server, "upgrade");
    const controller = new AbortController();
    const pending = openScenarioSession(
      { ...scenario, clients: [], sources: [{ id: "a", name: "A" }] },
      baseUrl,
      { signal: controller.signal },
    );
    const rejected = assert.rejects(pending, /cancelled/);
    const [, socket] = await upgraded;

    socket.on("end", () => socket.destroy());
    controller.abort(new Error("cancelled"));
    await rejected;
  },
);
