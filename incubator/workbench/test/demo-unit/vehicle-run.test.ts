import assert from "node:assert/strict";
import test from "node:test";
import { automaticFixture } from "../support/automatic-demo.js";

test("vehicle run opens its scenario once and closes each resource once", async () => {
  const f = automaticFixture();
  const run = await f.startRun();

  assert.equal(await run.openScenario(), await run.openScenario());
  await run.closeScenario();
  await Promise.all([run.close(), run.close()]);
  await run.close();

  assert.deepEqual(f.calls, [
    "start service",
    "start browser",
    "open scenario",
    "close scenario",
    "close browser",
    "close service",
  ]);
  await assert.rejects(run.openScenario(), /closing/);
});

test("vehicle run closes browser and service without opening a scenario", async () => {
  const f = automaticFixture();
  const run = await f.startRun();

  await run.close();

  assert.deepEqual(f.calls, [
    "start service",
    "start browser",
    "close browser",
    "close service",
  ]);
  await assert.rejects(run.openScenario(), /closing/);
});

test("vehicle run retains all cleanup failures and does not repeat cleanup", async () => {
  const f = automaticFixture({ closeFailure: true, browserCloseFailure: true });
  const run = await f.startRun();

  await run.openScenario();

  const verify = (error: unknown) => {
    assert.ok(error instanceof Error && error.cause instanceof AggregateError);
    assert.deepEqual(
      error.cause.errors.map((e) => e.message),
      ["scenario cleanup failed", "browser cleanup failed"],
    );

    return true;
  };

  await assert.rejects(run.close(), verify);
  await assert.rejects(run.close(), verify);
  assert.deepEqual(f.calls.slice(-3), [
    "close scenario",
    "close browser",
    "close service",
  ]);
});

test(
  "vehicle run cancels pending scenario setup before releasing browser and service",
  { timeout: 5000 },
  async () => {
    const f = automaticFixture({ pendingScenario: true });
    const run = await f.startRun();
    const opening = assert.rejects(
      run.openScenario(),
      /Vehicle scenario closed/,
    );

    await run.close();
    await opening;

    assert.deepEqual(f.calls.slice(-2), ["close browser", "close service"]);
  },
);
