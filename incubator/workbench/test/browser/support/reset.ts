import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { createVehicleDemo } from "../../../src/demos/vehicle/vehicle-demo.js";

/** Reset destroys the input target. Require both closure and a fresh ready run. */
export async function resetThroughBrowser(
  demo: ReturnType<typeof createVehicleDemo>,
  input: () => Promise<void>,
) {
  const old = demo.browser!;
  const closed = old.page.waitForEvent("close", { timeout: 30_000 });
  // Attach a handler immediately, even if input itself fails first.
  const action = input().catch((error: unknown) => {
    if (
      !old.page.isClosed() ||
      !(error instanceof Error) ||
      !/Target page, context or browser has been closed|^locator\.click: Browser closed$/.test(
        error.message,
      )
    )
      throw error;
  });

  await Promise.all([closed, action]);

  const deadline = Date.now() + 30_000;

  while (demo.browser === old || demo.state.phase !== "ready") {
    assert.notEqual(demo.state.phase, "failed", JSON.stringify(demo.state));
    assert.ok(Date.now() < deadline, JSON.stringify(demo.state));
    await delay(20);
  }

  assert.notEqual(demo.browser!.host.runId, old.host.runId);
}
