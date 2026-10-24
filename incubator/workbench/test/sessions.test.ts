import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { openScenarioSession } from "../src/scenario-session.js";
import { startZooGlassSession } from "../src/zooglass-session.js";
import { playScenario } from "../src/playback.js";
import type { Scenario } from "../src/scenario.js";

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

test("session modules can be imported without starting a service or running the CLI", async () => {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'await import("./src/scenario-session.ts"); await import("./src/zooglass-session.ts"); await import("./src/namespace-scenario.ts");',
    ],
    { timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  assert.deepEqual(await once(child, "close"), [0, null]);
  assert.equal(output, "");
});

test("client binding receives every client action and closes once", async () => {
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
  const trace = playScenario(scenario);
  for (const entry of trace) await session.execute(entry);
  assert.deepEqual(seen, trace);
  await Promise.all([session.close(), session.close()]);
  assert.equal(closes, 1);
  await assert.rejects(session.execute(trace[0]), /session closed/);
});

test("closing cancels an active executor, rejects overlap and waits before disposal", async () => {
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

async function localService(
  t: TestContext,
  handler: Parameters<typeof createServer>[0],
) {
  const server = createServer(handler);
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

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
    const accept = createHash("sha1")
      .update(
        `${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (data: Buffer) => {
      if ((data[0] & 15) === 8) socket.end(Buffer.from([0x88, 0]));
    });
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

// A tiny wrapper fixture exercises real child-process ownership without starting Maven.
async function serviceFixture(
  t: TestContext,
  mode: "healthy" | "unhealthy" | "exit" | "stubborn",
) {
  const directory = await mkdtemp(join(tmpdir(), "workbench-service-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "service.cjs");
  await writeFile(
    script,
    `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(join(directory, "started.json"))}, JSON.stringify({ pid: process.pid, config: process.env.ZOOGLASS_VIEWS_CONFIG }));
    if (${JSON.stringify(mode)} === "exit") process.kill(process.pid, "SIGTERM");
    if (${JSON.stringify(mode)} === "stubborn") process.on("SIGTERM", () => {});
    const port = Number(process.argv.find(arg => arg.includes("--server.port=")).match(/--server.port=(\\d+)/)[1]);
    require("node:http").createServer((_req, res) => { res.statusCode = ${mode === "unhealthy" ? 503 : 200}; res.end("{}"); }).listen(port, "127.0.0.1");
  `,
  );
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(
    join(directory, "mvnw"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
    { mode: 0o755 },
  );
  return {
    directory,
    async started() {
      return JSON.parse(
        await readFile(join(directory, "started.json"), "utf8"),
      ) as { pid: number; config: string };
    },
  };
}
const processTestOptions = {
  skip: process.platform === "win32",
  timeout: 10_000,
};
const views = [{ id: "position", fields: {} }];

test(
  "process close is idempotent and waits for forced termination before removing configuration",
  processTestOptions,
  async (t) => {
    const fixture = await serviceFixture(t, "stubborn");
    const session = await startZooGlassSession({
      serviceDirectory: fixture.directory,
      views,
      shutdownTimeoutMs: 50,
    });
    t.after(() => session.close());
    const { pid, config } = await fixture.started();
    assert.deepEqual(
      JSON.parse(await readFile(fileURLToPath(config), "utf8")),
      { views },
    );
    await Promise.all([session.close(), session.close()]);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(access(fileURLToPath(config)), { code: "ENOENT" });
    assert.equal(session.signal.aborted, true);
  },
);

for (const mode of ["unhealthy", "exit"] as const) {
  test(
    `failed ${mode} startup removes process and configuration`,
    processTestOptions,
    async (t) => {
      const fixture = await serviceFixture(t, mode);
      await assert.rejects(
        startZooGlassSession({
          serviceDirectory: fixture.directory,
          views,
          startupTimeoutMs: 3_000,
        }),
        mode === "exit" ? /aborted|SIGTERM/ : /healthy/,
      );
      const { pid, config } = await fixture.started();
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      await assert.rejects(access(fileURLToPath(config)), { code: "ENOENT" });
    },
  );
}

test("spawn errors reject promptly and cancellation prevents startup", async () => {
  await assert.rejects(
    startZooGlassSession({
      serviceDirectory: "/nonexistent/workbench-service",
    }),
    /aborted|ENOENT/,
  );
  await assert.rejects(
    startZooGlassSession({ signal: AbortSignal.abort(new Error("cancelled")) }),
    /cancelled/,
  );
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
      const accept = createHash("sha1")
        .update(
          `${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
        )
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.on("data", (data: Buffer) => {
        if ((data[0] & 15) === 8) socket.end(Buffer.from([0x88, 0]));
      });
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
