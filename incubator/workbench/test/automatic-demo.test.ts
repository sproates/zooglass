import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { automaticFixture } from "./support/automatic-demo.js";

for (const failAt of ["browser", "scenario", "execute"] as const) {
  test(`automatic ${failAt} failure closes acquired resources and removes signal handlers`, async () => {
    const f = automaticFixture({ failAt });
    await assert.rejects(f.run(), /failed/);
    assert.deepEqual(
      f.calls.filter((call) => call.startsWith("close")),
      failAt === "browser"
        ? ["close service"]
        : failAt === "scenario"
          ? ["close browser", "close service"]
          : ["close scenario", "close browser", "close service"],
    );
    assert.equal(f.process.listenerCount("SIGINT"), 0);
    assert.equal(f.process.listenerCount("SIGTERM"), 0);
  });
}

for (const failAt of ["scenario", "execute"] as const) {
  test(
    `visible automatic ${failAt} failure retains browser until inspection ends`,
    { timeout: 5000 },
    async () => {
      const f = automaticFixture({ failAt });
      const inspecting = once(f.events, "inspection");
      const run = f.run(false);
      const rejected = assert.rejects(run, /failed/);
      await inspecting;
      assert.equal(f.process.exitCode, 1);
      assert.equal(f.calls.includes("close browser"), false);
      assert.equal(f.calls.includes("close service"), false);
      assert.equal(f.calls.includes("close scenario"), failAt === "execute");
      f.page.emit("close");
      await rejected;
      assert.deepEqual(f.calls.slice(-2), ["close browser", "close service"]);
      assert.equal(f.process.listenerCount("SIGTERM"), 0);
    },
  );
}

for (const delayed of [false, true]) {
  test(
    `automatic interruption during ${delayed ? "delay" : "completion wait"} closes the run`,
    { timeout: 5000 },
    async () => {
      const f = automaticFixture({ delayed });
      const ready = once(f.events, delayed ? "delay" : "complete");
      const run = f.run();
      await ready;
      f.process.emit("SIGTERM");
      await run;
      assert.deepEqual(f.calls.slice(-3), [
        "close scenario",
        "close browser",
        "close service",
      ]);
      assert.equal(f.process.listenerCount("SIGTERM"), 0);
    },
  );
}

test("automatic cleanup attempts browser and service after scenario close fails", async () => {
  const f = automaticFixture({ failAt: "execute", closeFailure: true });
  await assert.rejects(f.run());
  assert.deepEqual(f.calls.slice(-3), [
    "close scenario",
    "close browser",
    "close service",
  ]);
});
