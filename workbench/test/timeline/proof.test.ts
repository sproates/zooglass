import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { Agenda } from "../../src/timeline/agenda.js";
import { Bridge } from "../../src/timeline/bridge.js";
import { compareReplay, runProof } from "../../src/timeline/proof.js";
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
  });
  compareReplay(first, replay);
  const tampered = structuredClone(first);
  tampered.trace[10].operation.op = "tampered";
  assert.throws(
    () => compareReplay(tampered, replay),
    /first divergence at turn 10/,
  );
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
  await runProof({ jar, seed, scenario: "delivery", hostDelay: 1 });
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
