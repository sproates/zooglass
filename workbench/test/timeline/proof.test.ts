import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { Agenda } from "../../src/timeline/agenda.js";
import { Bridge } from "../../src/timeline/bridge.js";
import {
  compareReplay,
  runProof,
  type ProofResult,
} from "../../src/timeline/proof.js";
import { loseReceipt } from "../../src/timeline/random.js";
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ?? "../zooglass/target/zooglass.jar",
);
const seed = "0".repeat(64);

test("rounds preserve same-time bursts, phases and cancellation", async () => {
  const agenda = new Agenda();
  const observed: string[] = [];
  agenda.add(
    10,
    2,
    async () => {
      observed.push("input");
      agenda.add(10, 0, async () => {
        observed.push("derived");
      });
    },
    undefined,
    true,
  );
  agenda.add(
    10,
    1,
    async () => {
      observed.push("timer");
    },
    undefined,
    true,
  );
  agenda.add(
    10,
    2,
    async () => {
      observed.push("second input");
    },
    undefined,
    true,
  );
  agenda.add(
    9,
    2,
    async () => {
      observed.push("cancelled");
    },
    1,
    true,
  );
  agenda.cancel(1);
  await agenda.through(10);
  assert.deepEqual(observed, ["timer", "input", "second input", "derived"]);
});
test("keyed receipt-loss vectors", () => {
  assert.deepEqual(loseReceipt(seed, "receipt"), {
    lost: true,
    digest: "3416900fd8e30db191adb87ebe56c575ab8e469c971e7cef355ce96462e974a5",
  });
  assert.equal(loseReceipt("2".repeat(64), "receipt").lost, false);
});
test("fresh execution replays actual outputs despite delays; tampering diverges", async () => {
  const first = await runProof({ jar, seed, scenario: "receipt" });
  const replay = await runProof({
    jar,
    seed,
    scenario: "receipt",
    hostDelay: 1,
    paced: true,
    replay: first,
  });
  compareReplay(first, replay);
  const tampered = structuredClone(first);
  const changed = tampered.trace.findIndex((entry) =>
    entry.effects.some((effect) => effect.kind === "frame"),
  );
  tampered.trace[changed].effects.find(
    (effect) => effect.kind === "frame",
  )!.wire = '{"incorrect":true}';
  await assert.rejects(
    runProof({
      jar,
      seed,
      scenario: "receipt",
      replay: tampered,
      idlePause: false,
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        new RegExp(`first divergence at turn ${changed}`),
      );
      const prefix = (error as Error & { proof: ProofResult }).proof;
      assert.equal(
        prefix.trace.length,
        changed + 1,
        "replay stops at the divergent effect",
      );
      assert.equal(
        prefix.trace.some((entry) => entry.operation.op === "ingress"),
        false,
      );
      return true;
    },
  );

  const timeout = first.trace.find(
    (entry) => entry.operation.op === "source-timeout",
  )!;
  const reconnect = first.trace.find(
    (entry) =>
      entry.operation.op === "connect" &&
      entry.operation.session === "source-2",
  )!;
  assert.equal(timeout.key[2], 1);
  assert.equal(reconnect.key[2], 0);
  assert.equal(
    reconnect.key[1],
    timeout.key[1] + 1,
    "reconnection is a later causal turn",
  );
  for (const entry of first.trace) {
    if (
      ["initialize", "connect", "disconnect", "shutdown"].includes(
        String(entry.operation.op),
      )
    ) {
      assert.equal(entry.key[2], 0, "lifecycle phase");
    }
    if (entry.effects.some((effect) => effect.kind === "handoff")) {
      assert.equal(entry.key[2], 1, "writer task phase");
    }
    if (entry.effects.some((effect) => effect.kind === "frame")) {
      assert.equal(entry.key[2], 2, "transport completion/arrival phase");
    }
  }
  const different = await runProof({
    jar,
    seed: "2".repeat(64),
    scenario: "receipt",
  });
  assert.notDeepEqual(first.trace, different.trace);
  assert.equal(
    different.trace.some((entry) => entry.operation.op === "source-timeout"),
    false,
  );
});
test("stalled delivery exercises real coalescing and baseline ordering", async () => {
  const result = await runProof({
    jar,
    seed,
    scenario: "delivery",
    hostDelay: 1,
  });
  for (const entry of result.trace.filter((entry) =>
    ["stall", "release"].includes(String(entry.operation.op)),
  )) {
    assert.equal(entry.key[2], 0, "link-state phase");
    assert.equal(
      entry.effects.some((effect) => effect.kind === "frame"),
      false,
      "release defers transport completion",
    );
  }
});

test("literal oracles reject incorrect client data and receipt targets", async (context) => {
  const command = Bridge.prototype.command;
  for (const corruption of ["frame", "receipt"]) {
    const replacement = context.mock.method(
      Bridge.prototype,
      "command",
      async function (this: Bridge, time, operation) {
        const response = await command.call(this, time, operation);
        for (const effect of response.effects) {
          if (effect.kind !== corruption || !effect.wire) {
            continue;
          }
          const body = JSON.parse(effect.wire);
          if (corruption === "receipt") {
            body.targets = [];
          } else if (body.type === "view-update") {
            body.data = { incorrect: true };
          }
          effect.wire = JSON.stringify(body);
        }
        return response;
      },
    );
    try {
      await assert.rejects(
        runProof({ jar, seed, scenario: "receipt", idlePause: false }),
        corruption === "frame" ? /client viewer-slow/ : /publication receipt 0/,
      );
    } finally {
      replacement.mock.restore();
    }
  }
});

test("invalid seeds are rejected before launching a runtime", async (context) => {
  const launch = context.mock.method(Bridge, "open", async () => {
    throw new Error("Runtime launch should not happen");
  });
  await assert.rejects(
    runProof({ jar, seed: "invalid", scenario: "receipt" }),
    /Expected 256-bit seed/,
  );
  assert.equal(launch.mock.callCount(), 0);
});

test("overlapping commands are rejected without consuming an identity or sending", async () => {
  for (const hostDelay of [0, 2]) {
    const { bridge } = await Bridge.open(jar, hostDelay);
    try {
      const first = bridge.command(0, {
        op: "initialize",
        policy: "coalesceLatestState",
      });
      await assert.rejects(
        bridge.command(0, { op: "observe" }),
        /Overlapping bridge commands/,
      );
      await first;
      const next = await bridge.command(0, { op: "observe" });
      assert.equal(next.turnId, 1);
      assert.deepEqual(next.effects, []);
      await assert.rejects(
        bridge.command(0, {
          op: "subscribe",
          wire: "x".repeat(16 * 1024 * 1024),
        }),
        /Command frame overflow/,
      );
      assert.equal((await bridge.command(0, { op: "observe" })).turnId, 2);
    } finally {
      await bridge.close();
    }
  }
});
test("disabled alarms fail a named behavioural assertion, without snapshot repair", async () => {
  await assert.rejects(
    runProof({ jar, seed, scenario: "receipt", disableAlarms: true }),
    /deadline expiry must originate from alarm/,
  );
});
test("bridge rejects unsupported initialization and nonmonotonic identities", async () => {
  for (const operation of [
    { op: "initialize", policy: "unknown" },
    { op: "initialize", policy: "coalesceLatestState", protectedAccess: true },
    { op: "initialize", policy: "coalesceLatestState", storage: "sqlite" },
    { op: "observe" },
  ]) {
    const { bridge } = await Bridge.open(jar);
    try {
      await assert.rejects(bridge.command(0, operation), /Runtime exited/);
    } finally {
      await bridge.close();
    }
  }
  const { bridge } = await Bridge.open(jar);
  try {
    await bridge.command(0, {
      op: "initialize",
      policy: "coalesceLatestState",
    });
    await bridge.command(2, { op: "observe" });
    await assert.rejects(
      bridge.command(1, { op: "observe" }),
      /Runtime exited/,
    );
  } finally {
    await bridge.close();
  }
});
