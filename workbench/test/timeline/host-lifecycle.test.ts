import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Bridge } from "../../src/timeline/bridge.js";
import type { Response } from "../../src/timeline/host-protocol.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
const session = "viewer-reused";
const wire = JSON.stringify({
  action: "subscribe",
  viewId: "position",
  entityId: "bus",
});

function dispatchScheduled(bridge: Bridge, response: Response) {
  const scheduled = response.effects.find(({ kind }) => kind === "schedule");
  assert.ok(scheduled, "host schedules the next callback");
  return bridge.command(response.timeMs, { op: "task", task: scheduled.task });
}

test("disconnect discards a stalled handoff before the session name is reused", async () => {
  const { bridge } = await Bridge.open(jar);
  try {
    await bridge.command(0, {
      op: "initialize",
      policy: "coalesceLatestState",
    });
    await bridge.command(0, { op: "connect", session });
    await bridge.command(0, { op: "stall", session });
    const subscribed = await bridge.command(0, {
      op: "subscribe",
      session,
      wire,
    });
    const blocked = await dispatchScheduled(bridge, subscribed);
    assert.equal(blocked.heldFrames, 1);

    const disconnected = await bridge.command(0, { op: "disconnect", session });
    assert.equal(disconnected.heldFrames, 0);
    await bridge.command(0, { op: "connect", session });
    const resubscribed = await bridge.command(0, {
      op: "subscribe",
      session,
      wire,
    });
    const replacement = await dispatchScheduled(bridge, resubscribed);

    assert.equal(
      replacement.heldFrames,
      0,
      "the replacement link is not stalled",
    );
    assert.deepEqual(
      replacement.effects.map(({ kind }) => kind),
      ["handoff", "schedule"],
    );
    const completed = await dispatchScheduled(bridge, replacement);
    assert.deepEqual(completed.effects[0], {
      kind: "frame",
      session,
      wire: '{"entityId":"bus","recovery":"freshSnapshot","type":"subscribed","viewId":"position"}',
    });
  } finally {
    await bridge.close();
  }
});

test("a queued close from a failed handoff cannot close a replacement session", async () => {
  const { bridge } = await Bridge.open(jar);
  try {
    await bridge.command(0, {
      op: "initialize",
      policy: "coalesceLatestState",
    });
    await bridge.command(0, { op: "connect", session });
    await bridge.command(0, { op: "stall", session });
    const subscribed = await bridge.command(0, {
      op: "subscribe",
      session,
      wire,
    });
    await dispatchScheduled(bridge, subscribed);
    const released = await bridge.command(0, {
      op: "release",
      session,
      fail: true,
    });
    const failed = await dispatchScheduled(bridge, released);
    assert.deepEqual(
      failed.effects.map(({ kind }) => kind),
      ["schedule"],
    );

    const disconnected = await bridge.command(0, { op: "disconnect", session });
    assert.deepEqual(disconnected.effects, [
      { kind: "close", session, code: 1000 },
    ]);
    await bridge.command(0, { op: "connect", session });
    const delayedClose = await dispatchScheduled(bridge, failed);

    assert.deepEqual(
      delayedClose.effects,
      [],
      "disconnect already closed the original connection",
    );
    const subscribedAgain = await bridge.command(0, {
      op: "subscribe",
      session,
      wire,
    });
    assert.deepEqual(
      subscribedAgain.effects.map(({ kind }) => kind),
      ["schedule"],
    );
  } finally {
    await bridge.close();
  }
});
