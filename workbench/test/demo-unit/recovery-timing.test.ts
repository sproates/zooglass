import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import type {
  ClientBinding,
  Command,
} from "../../../demos/vehicle-tracker/src/subscription-client.js";

async function fixture(t: TestContext, hanging = false) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: string[] = [];
  const failures: string[] = [];
  const transports: ((reason: string, transport: boolean) => void)[] = [];
  let connects = 0;
  const source = (
    await readFile(
      new URL(
        "../../../demos/vehicle-tracker/dist/recovering-client.js",
        import.meta.url,
      ),
      "utf8",
    )
  )
    .replace(/import[\s\S]*?from "\.\/subscription-client.js";/, "")
    .replace(
      "export function createRecoveringClient",
      "function createRecoveringClient",
    );
  const binding = { onConnection() {}, onSubscription() {}, onView() {} };
  const client = runInNewContext(
    source + "\ncreateRecoveringClient('/data', report, fail, binding)",
    {
      setTimeout,
      clearTimeout,
      AbortController,
      AbortSignal,
      Error,
      binding,
      report: (event: { event: string }) => events.push(event.event),
      fail: (reason: string) => failures.push(reason),
      createSubscriptionClient(
        _path: string,
        _report: unknown,
        lost: (reason: string, transport: boolean) => void,
        hooks: ClientBinding,
      ) {
        transports.push(lost);
        return {
          async execute(command: Command) {
            if (command.action !== "connect") return 1;
            connects++;
            hooks.onConnection("connecting");
            if (connects === 1) {
              hooks.onConnection("connected");
              return 1;
            }
            if (hanging) await new Promise(() => {});
            lost("refused", true);
            throw new Error("refused");
          },
          close() {},
        };
      },
    },
  );
  await client.execute({ action: "connect" });
  await client.execute({
    action: "subscribe",
    viewId: "stock",
    entityId: "warehouse",
  });
  client.expectRecovery();
  transports[0]("interrupted", true);
  return {
    client,
    events,
    failures,
    get connects() {
      return connects;
    },
    async tick(ms: number) {
      t.mock.timers.tick(ms);
      // Drain the promise chain around an attempt, without advancing wall time.
      for (let i = 0; i < 12; i++) await Promise.resolve();
    },
  };
}

test("retries back off through 250, 500, 1000 and capped 2000 ms; close cancels timers", async (t) => {
  const f = await fixture(t);
  try {
    for (const delay of [250, 500, 1000, 2000, 2000]) {
      const before = f.connects;
      await f.tick(delay - 1);
      assert.equal(f.connects, before);
      await f.tick(1);
      assert.equal(f.connects, before + 1);
    }
    f.client.close();
    const before = f.connects;
    await f.tick(30_000);
    assert.equal(f.connects, before);
    assert.deepEqual(f.failures, []);
    await assert.rejects(f.client.execute({ action: "connect" }), /closed/);
  } finally {
    f.client.close();
  }
});

test("a hanging open attempt expires after ten seconds and the total budget still expires", async (t) => {
  const f = await fixture(t, true);
  try {
    await f.tick(250);
    assert.equal(f.connects, 2);
    await f.tick(9999);
    assert.equal(f.connects, 2);
    await f.tick(1);
    await f.tick(499);
    assert.equal(f.connects, 2);
    await f.tick(1);
    assert.equal(f.connects, 3);
    await f.tick(30_000);
    assert.deepEqual(f.failures, [
      "Recovery timed out before all snapshots arrived.",
    ]);
  } finally {
    f.client.close();
  }
});
