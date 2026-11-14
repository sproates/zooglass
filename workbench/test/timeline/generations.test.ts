import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Bridge, type Response } from "../../src/timeline/bridge.js";
import { RuntimeGenerations } from "../../src/timeline/runtime-generations.js";
import { epoch, fixture, receipt } from "./document-fixture.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
const configuration = JSON.stringify(fixture().configuration);
const publication = JSON.stringify(fixture().document.publications[0].body);
function runtime(commandLimit = 100, pause = 0) {
  return new RuntimeGenerations({
    jar,
    configuration,
    epochMillis: epoch,
    commandLimit,
    hostDelay: pause,
    jvmPauseMs: pause,
  });
}
function clocks(
  response: Response,
  generation: number,
  turn: number,
  time: number,
  monotonic: number,
) {
  assert.deepEqual(
    [
      response.runtimeGeneration,
      response.turnId,
      response.timeMs,
      response.monotonicMs,
      response.wallMillis,
    ],
    [generation, turn, time, monotonic, epoch + time],
  );
}
function expiry(response: Response) {
  const task = response.effects.find((effect) => effect.kind === "schedule");
  assert.ok(task && task.kind === "schedule");
  return task;
}

for (const mode of ["orderly", "abrupt"] as const) {
  test(`${mode} restart resets real memory state and monotonic age while global wall time and turns continue`, async () => {
    const owner = runtime();
    try {
      clocks(await owner.start(0), 1, 0, 0, 0);
      const first = owner.current!;
      await owner.command(first, 0, {
        op: "connect",
        session: "source-1",
        role: "source",
      });
      const applied = await owner.command(first, 10, {
        op: "ingress",
        session: "source-1",
        wire: publication,
      });
      clocks(applied, 1, 2, 10, 10);
      const oldTask = expiry(applied);
      assert.equal(oldTask.at, 60);
      const stopped = await owner.stop(first, 11, mode);
      if (mode === "orderly") {
        assert.ok(stopped);
        clocks(stopped, 1, 3, 11, 11);
        assert.ok(
          stopped.effects.some(
            (effect) =>
              effect.kind === "cancel" && effect.task === oldTask.task,
          ),
        );
      } else assert.equal(stopped, undefined);
      assert.equal(owner.current, undefined);
      await assert.rejects(
        owner.command(first, 20, { op: "observe" }),
        /unavailable/,
      );

      const nextTurn = mode === "orderly" ? 4 : 3;
      clocks(await owner.start(50), 2, nextTurn, 50, 0);
      const second = owner.current!;
      await assert.rejects(
        owner.command(first, 50, { op: "task", task: oldTask.task }),
        /Stale runtime generation/,
      );
      await owner.command(second, 50, {
        op: "connect",
        session: "source-2",
        role: "source",
      });
      const reapplied = await owner.command(second, 50, {
        op: "ingress",
        session: "source-2",
        wire: publication,
      });
      clocks(reapplied, 2, nextTurn + 2, 50, 0);
      const acknowledgment = reapplied.effects.find(
        (effect) => effect.kind === "receipt",
      );
      assert.ok(acknowledgment?.kind === "receipt");
      assert.deepEqual(JSON.parse(acknowledgment.wire), receipt(1, 1));
      const newTask = expiry(reapplied);
      assert.equal(
        newTask.task,
        oldTask.task,
        "host-local IDs may repeat across generations",
      );
      assert.equal(
        newTask.at,
        100,
        "new expiry uses the global agenda coordinate",
      );
      const state = reapplied.effects.find((effect) => effect.kind === "state");
      assert.ok(state?.kind === "state");
      assert.equal(
        JSON.parse(state.wire).status.fields.reading.receivedAtMillis,
        epoch + 50,
      );
      const before = await owner.command(second, 99, { op: "observe" });
      clocks(before, 2, nextTurn + 3, 99, 49);
      assert.deepEqual(before.effects, []);
      const expired = await owner.command(second, 100, {
        op: "task",
        task: newTask.task,
      });
      const stale = expired.effects.find((effect) => effect.kind === "state");
      assert.ok(stale?.kind === "state");
      assert.equal(JSON.parse(stale.wire).version, 2);
      assert.equal(
        JSON.parse(stale.wire).status.fields.reading.freshness,
        "stale",
      );
      await owner.stop(second, 100, "orderly");
    } finally {
      await owner.close();
    }
  });
}

test("same-time restart preserves the global command budget and rejects lifecycle misuse", async () => {
  const owner = runtime(4);
  try {
    await assert.rejects(owner.start(1), /starts at zero/);
    await owner.start(0);
    const first = owner.current!;
    await assert.rejects(owner.start(0), /already available/);
    await assert.rejects(
      owner.command(first, 0, { op: "shutdown" }),
      /lifecycle ownership/,
    );
    await owner.stop(first, 10, "orderly");
    clocks(await owner.start(10), 2, 2, 10, 0);
    const second = owner.current!;
    await assert.rejects(
      owner.command(second, 9, { op: "observe" }),
      /global runtime time/,
    );
    clocks(await owner.command(second, 10, { op: "observe" }), 2, 3, 10, 0);
    await assert.rejects(
      owner.command(second, 11, { op: "observe" }),
      /limit-exceeded: runtime commands/,
    );
    assert.equal(owner.current, undefined);
    await assert.rejects(owner.start(11), /limit-exceeded: runtime commands/);
  } finally {
    await owner.close();
  }
});

test("long host pauses do not advance clocks across a fresh generation", async () => {
  const owner = runtime(10, 70);
  try {
    await owner.start(0);
    await owner.stop(owner.current!, 20, "abrupt");
    clocks(await owner.start(50), 2, 1, 50, 0);
    const second = owner.current!;
    await owner.command(second, 50, {
      op: "connect",
      session: "source",
      role: "source",
    });
    const applied = await owner.command(second, 50, {
      op: "ingress",
      session: "source",
      wire: publication,
    });
    clocks(applied, 2, 3, 50, 0);
    assert.equal(expiry(applied).at, 100);
    assert.ok(
      applied.diagnostics?.pauses.some(
        (pause) => pause.requestedMillis === 70 && pause.virtualMs === 50,
      ),
    );
    await owner.stop(second, 50, "orderly");
  } finally {
    await owner.close();
  }
});

test("protocol2 is explicitly admitted and cannot be mistaken for document v2 support", async () => {
  const { bridge } = await Bridge.open(jar, 0, 0, {
    runtimeGeneration: 2,
    startTimeMs: 50,
    firstTurnId: 42,
  });
  try {
    assert.equal(bridge.protocol, 2);
    assert.equal(bridge.memoryLifecycle, 1);
    assert.deepEqual(bridge.documentFormats, []);
    clocks(
      await bridge.command(50, {
        op: "initialize-document",
        epochMillis: epoch,
        wire: configuration,
      }),
      2,
      42,
      50,
      0,
    );
    clocks(await bridge.command(50, { op: "shutdown" }), 2, 43, 50, 0);
    await bridge.finishOrderly();
    await assert.rejects(
      bridge.command(50, { op: "observe" }),
      /closed|completed|finished|stopped/i,
    );
  } finally {
    await bridge.close();
  }
});

test("abrupt termination needs no spare command budget and exhausted restart does not launch", async (context) => {
  const owner = runtime(1);
  try {
    await owner.start(0);
    await owner.stop(owner.current!, 1, "abrupt");
    const open = context.mock.method(Bridge, "open", () => {
      throw new Error("Unexpected process launch");
    });
    await assert.rejects(owner.start(2), /limit-exceeded: runtime commands/);
    assert.equal(open.mock.callCount(), 0);
  } finally {
    await owner.close();
  }
});

test("rejected stale handles and overlapping calls cannot consume time or command identities", async () => {
  const owner = runtime(20, 70);
  try {
    await owner.start(0);
    const first = owner.current!;
    await owner.stop(first, 0, "abrupt");
    await owner.start(10);
    const second = owner.current!;
    await assert.rejects(
      owner.command(first, 100, { op: "observe" }),
      /Stale runtime generation/,
    );
    const pending = owner.command(second, 10, { op: "observe" });
    await assert.rejects(owner.stop(second, 100, "abrupt"), /Overlapping/);
    await assert.rejects(owner.close(), /Overlapping/);
    clocks(await pending, 2, 2, 10, 0);
    clocks(await owner.command(second, 11, { op: "observe" }), 2, 3, 11, 1);
  } finally {
    await owner.close();
  }
});

test("failed command remains the primary error when cleanup also fails", async (context) => {
  const owner = runtime();
  try {
    await owner.start(0);
    const generation = owner.current!;
    const original = new Error("Original command failure");
    const close = Bridge.prototype.close;
    context.mock.method(Bridge.prototype, "command", async () => {
      throw original;
    });
    context.mock.method(
      Bridge.prototype,
      "close",
      async function (this: Bridge) {
        await close.call(this);
        throw new Error("Secondary cleanup failure");
      },
    );
    await assert.rejects(
      owner.command(generation, 1, { op: "observe" }),
      (error) => error === original,
    );
    assert.equal(owner.current, undefined);
    await assert.rejects(owner.start(2), (error) => error === original);
  } finally {
    await owner.close();
  }
});

test("replacement rejects changed environment identity and failed startup cannot be retried", async (context) => {
  const owner = runtime();
  try {
    await owner.start(0);
    await owner.stop(owner.current!, 0, "abrupt");
    const open = Bridge.open;
    context.mock.method(
      Bridge,
      "open",
      async (...args: Parameters<typeof Bridge.open>) => {
        const result = await open(...args);
        result.bridge.environment = {
          ...result.bridge.environment,
          javaVersion: "changed",
        };
        return result;
      },
    );
    await assert.rejects(
      owner.start(1),
      /environment changed between generations/,
    );
    assert.equal(owner.current, undefined);
    await assert.rejects(
      owner.start(2),
      /environment changed between generations/,
    );
  } finally {
    await owner.close();
  }
});

test("caller mutation cannot turn an admitted command into a lifecycle operation", async () => {
  const owner = runtime(10, 70);
  try {
    await owner.start(0);
    const generation = owner.current!;
    const operation = { op: "observe" };
    const pending = owner.command(generation, 1, operation);
    operation.op = "shutdown";
    clocks(await pending, 1, 1, 1, 1);
    clocks(await owner.command(generation, 2, { op: "observe" }), 1, 2, 2, 2);
    await owner.stop(generation, 2, "orderly");
  } finally {
    await owner.close();
  }
});

test("the runtime generation cap is global even for repeated same-time abrupt stops", async (context) => {
  const owner = runtime(20);
  try {
    for (let number = 1; number <= 16; number++) {
      clocks(await owner.start(0), number, number - 1, 0, 0);
      await owner.stop(owner.current!, 0, "abrupt");
    }
    const open = context.mock.method(Bridge, "open", () => {
      throw new Error("Unexpected seventeenth process");
    });
    await assert.rejects(owner.start(0), /limit-exceeded: runtime generations/);
    assert.equal(open.mock.callCount(), 0);
  } finally {
    await owner.close();
  }
});
