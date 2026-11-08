import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import type {
  ClientBinding,
  Command,
} from "../../../demos/vehicle-tracker/src/subscription-client.js";

type Message = Record<string, unknown>;

async function fixture(overrides: Partial<ClientBinding> = {}) {
  const sockets: Socket[] = [];
  const observations: Message[] = [];
  const calls: unknown[][] = [];
  const failures: string[] = [];

  class Socket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    sent: Message[] = [];
    listeners = new Map<string, ((event: { data: string }) => void)[]>();
    constructor() {
      sockets.push(this);
    }
    addEventListener(
      name: string,
      listener: (event: { data: string }) => void,
    ) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    }
    emit(name: string, message: Message = {}) {
      if (name === "open") {
        this.readyState = Socket.OPEN;
      }

      for (const listener of this.listeners.get(name) ?? []) {
        listener({ data: JSON.stringify(message) });
      }
    }
    send(data: string) {
      this.sent.push(JSON.parse(data));
    }
    close() {
      if (this.readyState === Socket.CLOSED) {
        return;
      }

      if (this.readyState === 0) this.emit("error");
      this.readyState = Socket.CLOSED;
      this.emit("close");
    }
  }

  const binding: ClientBinding = {
    validateSubscription(view, entity) {
      if (view !== "stock" || entity !== "warehouse-2") {
        throw new Error("Unknown inventory view.");
      }
    },
    connectionLostReason: "Inventory connection lost.",
    onConnection: (...args) => {
      calls.push(["connection", ...args]);
    },
    onSubscription: (...args) => {
      calls.push(["subscription", ...args]);
    },
    onView: (...args) => {
      calls.push(["view", ...args]);
    },
    ...overrides,
  };
  const source = (
    await readFile(
      new URL(
        "../../../demos/vehicle-tracker/dist/subscription-client.js",
        import.meta.url,
      ),
      "utf8",
    )
  ).replace(
    "export function createSubscriptionClient",
    "function createSubscriptionClient",
  );
  const client = runInNewContext(
    source + "\ncreateSubscriptionClient('/data', report, fail, binding)",
    {
      Error,
      URL,
      WebSocket: Socket,
      location: { host: "local" },
      report: (event: Message) => {
        observations.push(event);
        calls.push(["report", event.event]);
      },
      fail: (reason: string) => failures.push(reason),
      binding,
    },
  ) as {
    execute(command: Command): Promise<number>;
    close(): void;
    fail(reason: string): void;
  };

  async function connect() {
    const pending = client.execute({ action: "connect" });

    sockets.at(-1)!.emit("open");
    await pending;

    return sockets.at(-1)!;
  }

  async function subscribe(socket: Socket) {
    const pending = client.execute({
      action: "subscribe",
      viewId: "stock",
      entityId: "warehouse-2",
    });
    socket.emit("message", {
      type: "subscribed",
      viewId: "stock",
      entityId: "warehouse-2",
    });
    await pending;
  }

  return { client, connect, subscribe, observations, calls, failures, sockets };
}

const snapshot = {
  type: "view-update",
  viewId: "stock",
  entityId: "warehouse-2",
  data: { quantity: 12 },
};

test("a DOM-free inventory binding receives subscriptions and snapshots before observation", async () => {
  const f = await fixture();
  const socket = await f.connect();

  await f.subscribe(socket);
  socket.emit("message", snapshot);

  assert.deepEqual(socket.sent, [
    { action: "subscribe", viewId: "stock", entityId: "warehouse-2" },
  ]);
  assert.equal(
    JSON.stringify(f.calls.slice(-2)),
    JSON.stringify([
      ["view", "stock", "warehouse-2", { quantity: 12 }],
      ["report", "view-update"],
    ]),
  );
  assert.deepEqual(
    f.observations.map((e) => [
      e.event,
      e.connectionGeneration,
      e.observationIndex,
    ]),
    [
      ["opened", 1, 1],
      ["subscribed", 1, 2],
      ["view-update", 1, 3],
    ],
  );
  f.client.close();
});

test("application restrictions reject a command without writing to the socket", async () => {
  const f = await fixture();
  const socket = await f.connect();

  await assert.rejects(
    f.client.execute({
      action: "subscribe",
      viewId: "live-map",
      entityId: "car-17",
    }),
    /Unknown inventory view/,
  );
  assert.deepEqual(socket.sent, []);
  assert.deepEqual(f.failures, []);
  await f.subscribe(socket);
  f.client.close();
});

test("presentation rejection fails the run without reporting an accepted snapshot", async () => {
  const f = await fixture({
    onView() {
      throw new Error("Invalid inventory snapshot.");
    },
  });
  const socket = await f.connect();

  await f.subscribe(socket);
  socket.emit("message", snapshot);

  assert.deepEqual(f.failures, ["Invalid inventory snapshot."]);
  assert.equal(
    f.observations.some((e) => e.event === "view-update"),
    false,
  );
  assert.equal(socket.readyState, 3);
  await assert.rejects(
    f.client.execute({ action: "connect" }),
    /Invalid inventory snapshot/,
  );
});

test("reconnection ignores old socket callbacks and reports the new generation", async () => {
  const f = await fixture();
  const old = await f.connect();

  await f.subscribe(old);
  await f.client.execute({ action: "disconnect" });

  const current = await f.connect();
  const count = f.calls.length;

  old.emit("message", snapshot);
  old.emit("close");
  old.emit("error");

  assert.equal(f.calls.length, count);
  await f.subscribe(current);
  current.emit("message", snapshot);

  assert.equal(f.observations.at(-1)!.connectionGeneration, 2);
  assert.deepEqual(f.failures, []);
  f.client.close();
});

test("unexpected closure rejects pending acknowledgement and reports the binding's reason once", async () => {
  const f = await fixture();
  const socket = await f.connect();
  const pending = f.client.execute({
    action: "subscribe",
    viewId: "stock",
    entityId: "warehouse-2",
  });
  const rejected = assert.rejects(
    pending,
    /Connection closed before acknowledgement/,
  );

  socket.close();
  await rejected;
  f.client.fail("later failure");

  assert.deepEqual(f.failures, ["Inventory connection lost."]);
  assert.ok(
    f.calls.some(
      (call) =>
        call[0] === "connection" &&
        call[1] === "error" &&
        call[2] === "Inventory connection lost.",
    ),
  );
});

test(
  "a connected presentation failure rejects connect and closes the socket",
  { timeout: 1000 },
  async () => {
    const f = await fixture({
      onConnection(state) {
        if (state === "connected") {
          throw new Error("Cannot render connected state.");
        }
      },
    });

    await assert.rejects(f.connect(), /Cannot render connected state/);
    assert.deepEqual(f.failures, ["Cannot render connected state."]);
    assert.equal(
      f.observations.some((e) => e.event === "opened"),
      false,
    );
    assert.equal(f.observations.at(-1)!.event, "closed");
    await assert.rejects(
      f.client.execute({ action: "connect" }),
      /Cannot render connected state/,
    );
  },
);

test(
  "an error presentation failure cannot prevent command rejection or socket cleanup",
  { timeout: 1000 },
  async () => {
    const f = await fixture({
      onConnection(state) {
        if (state === "connected" || state === "error") {
          throw new Error(`Cannot render ${state}.`);
        }
      },
    });

    await assert.rejects(f.connect(), /Cannot render connected/);
    assert.deepEqual(f.failures, ["Cannot render connected."]);
    assert.equal(f.observations.at(-1)!.event, "closed");
  },
);

test(
  "a subscription presentation failure rejects the pending acknowledgement",
  { timeout: 1000 },
  async () => {
    const f = await fixture({
      onSubscription(_view, _entity, state) {
        if (state === "subscribed") {
          throw new Error("Cannot render subscription.");
        }
      },
    });
    const socket = await f.connect();

    await assert.rejects(f.subscribe(socket), /Cannot render subscription/);
    assert.deepEqual(f.failures, ["Cannot render subscription."]);
    assert.equal(socket.readyState, 3);
    assert.equal(
      f.observations.some((e) => e.event === "subscribed"),
      false,
    );
  },
);

for (const loss of ["close", "error"] as const) {
  test(`protected data clears on ${loss} and late frames are ignored`, async () => {
    let visible: unknown;
    const f = await fixture({
      onView: (_view, _entity, data) => {
        visible = data;
      },
      clearProtectedData: () => {
        visible = undefined;
      },
    });
    const socket = await f.connect();
    await f.subscribe(socket);
    socket.emit("message", snapshot);
    assert.ok(visible);
    if (loss === "close") f.client.close();
    else socket.emit("error");
    assert.equal(visible, undefined);
    socket.emit("message", snapshot);
    assert.equal(visible, undefined);
  });
}

test("a broken clearing callback cannot prevent socket cleanup or command rejection", async () => {
  const f = await fixture({
    clearProtectedData() {
      throw new Error("Cannot clear renderer");
    },
  });
  const socket = await f.connect();
  await f.subscribe(socket);
  f.client.fail("Access lost");
  assert.equal(socket.readyState, 3);
  await assert.rejects(f.client.execute({ action: "connect" }), /Access lost/);
});

for (const action of ["close", "disconnect", "fail"] as const) {
  test(`closing during handshake settles connect: ${action}`, async () => {
    const f = await fixture();
    let outcome = "pending";
    const pending = f.client.execute({ action: "connect" }).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    const old = f.sockets[0];
    if (action === "close") f.client.close();
    else if (action === "fail") f.client.fail("Cancelled");
    else await f.client.execute({ action: "disconnect" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(outcome, "rejected");
    await pending;
    if (action !== "fail") {
      const current = await f.connect();
      const count = f.calls.length;
      old.emit("open");
      old.emit("error");
      old.emit("close");
      assert.equal(f.calls.length, count);
      await f.subscribe(current);
      assert.deepEqual(f.failures, []);
      f.client.close();
    }
  });
}
