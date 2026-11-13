import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { zipSync } from "fflate";
import { Bridge } from "../../src/timeline/bridge.js";

function frame(value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

const generation = { runtimeGeneration: 2, startTimeMs: 50, firstTurnId: 42 };
const initialResponse = {
  turnId: 42,
  runtimeGeneration: 2,
  timeMs: 50,
  monotonicMs: 0,
  wallMillis: 1050,
  pendingTasks: 0,
  heldFrames: 0,
  effects: [],
};

async function pipe(
  context: TestContext,
  capability: Record<string, unknown> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "timeline-completion-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const jar = join(directory, "host.jar");
  const archive = zipSync({
    "META-INF/MANIFEST.MF": Buffer.from(
      "Manifest-Version: 1.0\r\n" +
        "Main-Class: org.springframework.boot.loader.launch.JarLauncher\r\n" +
        "Start-Class: io.zooglass.simulation.TimelineHost\r\n\r\n",
    ),
  });
  await writeFile(jar, archive);
  const artifact = createHash("sha256").update(archive).digest("hex");
  const signals: NodeJS.Signals[] = [];
  let ended = false;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      return !ended;
    },
  });
  const exit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (ended) return;
    ended = true;
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  };
  const open = async (hostDelay = 0) => {
    const { bridge } = await Bridge.open(jar, hostDelay, 0, generation);
    return bridge;
  };
  const reply = (value: unknown) => {
    child.stdin.once("data", () => child.stdout.write(frame(value)));
  };
  const initialize = (bridge: Bridge) => {
    reply(initialResponse);
    return bridge.command(50, {
      op: "initialize-document",
      wire: "{}",
      epochMillis: 1000,
    });
  };
  const spawn = context.mock.method(childProcess, "spawn", () => {
    queueMicrotask(() =>
      child.stdout.write(
        frame({
          protocol: 2,
          fixture: "timeline-proof-v1",
          artifact,
          frameCap: 16 * 1024 * 1024,
          storage: ["memory"],
          protectedAccess: false,
          memoryLifecycle: 1,
          documentFormats: [],
          environment: { javaRuntime: "25" },
          ...capability,
        }),
      ),
    );
    return child;
  });
  syncBuiltinESMExports();
  context.after(() => {
    spawn.mock.restore();
    syncBuiltinESMExports();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  });
  return { child, signals, exit, open, reply, initialize };
}

test("an unexpected prior exit is not accepted as an abrupt stop", async (context) => {
  const host = await pipe(context);
  const bridge = await host.open();
  try {
    await host.initialize(bridge);
    host.exit(null, "SIGKILL");
    await assert.rejects(bridge.finishAbruptly(), /Runtime exited \(SIGKILL\)/);
    assert.deepEqual(host.signals, []);
  } finally {
    host.exit(null, "SIGKILL");
    await bridge.close();
  }
});

for (const mode of ["orderly", "abrupt"] as const) {
  test(`${mode} completion waits for the expected process termination`, async (context) => {
    const host = await pipe(context);
    const bridge = await host.open();
    try {
      await host.initialize(bridge);
      if (mode === "orderly") {
        host.reply({ ...initialResponse, turnId: 43 });
        await bridge.command(50, { op: "shutdown" });
      }
      const stop =
        mode === "orderly" ? bridge.finishOrderly() : bridge.finishAbruptly();
      const rejected = assert.rejects(
        stop,
        new RegExp(`Unexpected ${mode} completion`),
      );
      assert.deepEqual(host.signals, mode === "orderly" ? [] : ["SIGKILL"]);
      assert.equal(host.child.stdin.writableEnded, mode === "orderly");
      await assert.rejects(bridge.command(50, { op: "observe" }), /closed/);
      await assert.rejects(bridge.finishAbruptly(), /closed/);
      host.exit(mode === "orderly" ? 7 : 0, null);
      await rejected;
    } finally {
      host.exit(null, "SIGKILL");
      await bridge.close();
    }
  });
}

test("completion cannot interrupt an unacknowledged turn or accept mismatched clocks", async (context) => {
  const host = await pipe(context);
  const bridge = await host.open();
  try {
    await host.initialize(bridge);
    const pending = bridge.command(51, { op: "observe" });
    const rejected = assert.rejects(
      pending,
      /Mismatched generation response clocks/,
    );
    await assert.rejects(
      bridge.finishAbruptly(),
      /Overlapping bridge commands/,
    );
    host.child.stdout.write(
      frame({
        ...initialResponse,
        turnId: 43,
        timeMs: 51,
        monotonicMs: 1,
        wallMillis: 1050,
      }),
    );
    await rejected;
    await assert.rejects(
      bridge.finishAbruptly(),
      /Mismatched generation response clocks/,
    );
    assert.deepEqual(host.signals, []);
  } finally {
    host.exit(null, "SIGKILL");
    await bridge.close();
  }
});

test("caller mutation cannot change a pending command or its acknowledgment", async (context) => {
  const host = await pipe(context);
  const bridge = await host.open(2);
  try {
    let sent: unknown;
    host.child.stdin.once("data", (bytes: Buffer) => {
      sent = JSON.parse(bytes.subarray(4).toString("utf8"));
    });
    host.reply(initialResponse);
    const initialize = {
      op: "initialize-document",
      wire: "{}",
      epochMillis: 1000,
    };
    const started = bridge.command(50, initialize);
    initialize.op = "shutdown";
    await started;
    assert.deepEqual(sent, {
      op: "initialize-document",
      wire: "{}",
      epochMillis: 1000,
      startTimeMs: 50,
      turnId: 42,
      runtimeGeneration: 2,
      timeMs: 50,
      monotonicMs: 0,
      wallMillis: 1050,
    });

    const shutdown = { op: "shutdown" };
    host.child.stdin.once("data", () => {
      shutdown.op = "observe";
    });
    host.reply({ ...initialResponse, turnId: 43 });
    await bridge.command(50, shutdown);
    const finished = bridge.finishOrderly();
    host.exit(0, null);
    await finished;
  } finally {
    host.exit(null, "SIGKILL");
    await bridge.close();
  }
});

test("an unsolicited frame invalidates an acknowledgment in the same pipe read", async (context) => {
  const host = await pipe(context);
  const bridge = await host.open();
  try {
    await host.initialize(bridge);
    const response = frame({ ...initialResponse, turnId: 43 });
    host.child.stdin.once("data", () => {
      host.child.stdout.write(Buffer.concat([response, response]));
    });
    await assert.rejects(
      bridge.command(50, { op: "shutdown" }),
      /Unsolicited bridge frame/,
    );
    await assert.rejects(bridge.finishOrderly(), /Unsolicited bridge frame/);
  } finally {
    host.exit(null, "SIGKILL");
    await bridge.close();
  }
});

test("a partial unsolicited frame invalidates an acknowledgment in the same pipe read", async (context) => {
  const host = await pipe(context);
  const bridge = await host.open();
  try {
    await host.initialize(bridge);
    host.child.stdin.once("data", () => {
      host.child.stdout.write(
        Buffer.concat([
          frame({ ...initialResponse, turnId: 43 }),
          Buffer.from([0]),
        ]),
      );
    });
    await assert.rejects(
      bridge.command(50, { op: "observe" }),
      /Unsolicited bridge frame/,
    );
  } finally {
    host.exit(null, "SIGKILL");
    await bridge.close();
  }
});

test("a partial frame received before a command cannot satisfy that command", async (context) => {
  const host = await pipe(context);
  const bridge = await host.open();
  try {
    await host.initialize(bridge);
    const response = frame({ ...initialResponse, turnId: 43 });
    host.child.stdout.write(response.subarray(0, 1));
    host.child.stdin.once("data", () =>
      host.child.stdout.write(response.subarray(1)),
    );
    await assert.rejects(
      bridge.command(50, { op: "observe" }),
      /Unsolicited bridge frame/,
    );
  } finally {
    host.exit(null, "SIGKILL");
    await bridge.close();
  }
});

test("orderly completion rejects bytes after a shutdown acknowledgment", async (context) => {
  const host = await pipe(context);
  const bridge = await host.open();
  try {
    await host.initialize(bridge);
    host.reply({ ...initialResponse, turnId: 43 });
    await bridge.command(50, { op: "shutdown" });
    const finished = bridge.finishOrderly();
    const rejected = assert.rejects(finished, /Unsolicited bridge frame/);
    host.child.stdout.write(Buffer.from([0]));
    host.exit(0, null);
    await rejected;
  } finally {
    host.exit(null, "SIGKILL");
    await bridge.close();
  }
});

test("completion and force cleanup both time out when the child never closes", async (context) => {
  const host = await pipe(context);
  const bridge = await host.open();
  try {
    await host.initialize(bridge);
    context.mock.timers.enable({ apis: ["setTimeout"] });

    const stopping = assert.rejects(
      bridge.finishAbruptly(),
      /watchdog expired during abrupt runtime completion/,
    );
    context.mock.timers.runAll();
    await stopping;
    assert.ok(
      host.child.stdin.destroyed &&
        host.child.stdout.destroyed &&
        host.child.stderr.destroyed,
    );

    const cleanup = assert.rejects(
      bridge.close(),
      /watchdog expired during runtime cleanup/,
    );
    context.mock.timers.runAll();
    await cleanup;
  } finally {
    host.exit(null, "SIGKILL");
    await bridge.close();
  }
});

test("a stalled cleanup preserves the original handshake rejection", async (context) => {
  const host = await pipe(context, { memoryLifecycle: undefined });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const destroying = once(host.child.stdin, "close");
  const rejected = assert.rejects(host.open(), /handshake.memoryLifecycle/);
  await destroying;
  context.mock.timers.runAll();
  await rejected;
});

for (const [capability, message] of [
  [{ memoryLifecycle: undefined }, /handshake.memoryLifecycle/],
  [
    { documentFormats: ["timeline-simulation/v2"] },
    /handshake.documentFormats/,
  ],
  [{ environment: {} }, /handshake.environment/],
] as const) {
  test(`protocol 2 rejects invalid ${Object.keys(capability)[0]} capability`, async (context) => {
    const host = await pipe(context, capability);
    // A rejected handshake must trigger cleanup before open reports the error.
    host.child.stdin.once("close", () => host.exit(null, "SIGKILL"));
    await assert.rejects(host.open(), message);
    assert.deepEqual(host.signals, ["SIGKILL"]);
  });
}
