import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

type Message = Record<string, unknown>;

async function bridge(
  execute: (message: Message) => Promise<number> = async () => 1,
) {
  const sent: Message[] = [];
  const calls: Message[] = [];
  const failures: string[] = [];
  let closes = 0;
  const listeners = new Map<string, ((event: { data: string }) => unknown)[]>();

  class Socket {
    static OPEN = 1;
    readyState = 1;
    addEventListener(
      name: string,
      listener: (event: { data: string }) => unknown,
    ) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    }
    send(data: string) {
      sent.push(JSON.parse(data));
    }
  }

  const client = {
    async execute(message: Message) {
      calls.push(message);
      return execute(message);
    },
    fail(reason: string) {
      failures.push(reason);
    },
    close() {
      closes++;
    },
  };
  const source = (
    await readFile(new URL("../browser/bridge.js", import.meta.url), "utf8")
  ).replace(
    "export function startBrowserBridge",
    "function startBrowserBridge",
  );

  runInNewContext(source + "\nstartBrowserBridge({ createClient });", {
    URLSearchParams,
    location: {
      hash: "#runId=run&clientId=client&token=secret",
      host: "local",
    },
    history: { replaceState() {} },
    WebSocket: Socket,
    createClient: () => client,
  });

  const emit = async (name: string, message: Message = {}) => {
    for (const listener of listeners.get(name) ?? [])
      await listener({ data: JSON.stringify(message) });
  };

  const receive = (message: Message) =>
    emit("message", { runId: "run", clientId: "client", ...message });

  await emit("open");

  assert.equal(sent[0].token, "secret");
  await receive({ type: "registered", dataPath: "/data" });

  assert.equal(sent.at(-1)!.type, "ready");

  const command = (id: string, action = "connect") =>
    receive({ type: "command", commandId: id, action });

  return {
    sent,
    calls,
    failures,
    closes: () => closes,
    receive,
    command,
    emit,
  };
}

test("bridge replays completed commands but rejects reuse with different arguments", async () => {
  const run = await bridge();

  await run.command("one");

  const result = run.sent.at(-1);

  await run.command("one");

  assert.deepEqual(run.sent.at(-1), result);
  assert.equal(run.calls.length, 1);
  await run.command("one", "disconnect");

  assert.match(
    String(run.sent.at(-1)!.reason),
    /reused with different arguments/,
  );
  assert.equal(run.sent.at(-1)!.type, "fatal");
});

test("bridge ignores stale identities and rejects invalid commands", async () => {
  const run = await bridge();
  const count = run.sent.length;

  await run.receive({
    type: "command",
    runId: "old",
    commandId: "one",
    action: "connect",
  });

  assert.equal(run.sent.length, count);
  assert.equal(run.calls.length, 0);
  await run.command("one", "invalid");

  assert.equal(run.sent.at(-1)!.type, "fatal");
});

test("bridge rejects overlap while the first command is still running", async () => {
  let release!: (generation: number) => void;
  const run = await bridge(
    () =>
      new Promise<number>((resolve) => {
        release = resolve;
      }),
  );
  const pending = run.command("one");

  try {
    await run.command("two");

    assert.match(String(run.sent.at(-1)!.reason), /action already running/);
    assert.equal(run.calls.length, 1);
  } finally {
    release(1);
    await pending;
  }

  assert.equal(run.sent.at(-1)!.type, "completed");
});

test("failed commands report failure and are not cached as completed", async () => {
  let fail = true;
  const run = await bridge(async () => {
    if (fail) throw new Error("client failed");

    return 2;
  });

  await run.command("one");

  assert.equal(run.sent.at(-1)!.type, "failed");
  assert.equal(run.sent.at(-1)!.reason, "client failed");
  fail = false;
  await run.command("one");

  assert.equal(run.calls.length, 2);
  assert.equal(run.sent.at(-1)!.connectionGeneration, 2);
});

test("bridge bounds completed commands at 256 while permitting cached replay", async () => {
  const run = await bridge();

  for (let i = 0; i < 256; i++) await run.command(String(i));
  await run.command("0");

  assert.equal(run.sent.at(-1)!.type, "completed");
  await run.command("overflow");

  assert.equal(run.sent.at(-1)!.type, "fatal");
  assert.equal(run.calls.length, 256);
});

test("control loss fails and closes the injected client", async () => {
  const run = await bridge();

  await run.emit("close");

  assert.deepEqual(run.failures, ["Workbench control connection lost."]);
  assert.equal(run.closes(), 1);
});
