import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { resetThroughBrowser } from "../browser/support/reset.js";

function resetFixture() {
  let pageClosed = false;
  let closePage!: () => void;
  const closed = new Promise<void>((resolve) => {
    closePage = () => {
      pageClosed = true;
      resolve();
    };
  });
  const old = {
    page: { isClosed: () => pageClosed, waitForEvent: () => closed },
    host: { runId: "old" },
  };
  const state = {
    browser: old,
    state: { phase: "resetting" },
  };
  // Only the reset helper's observed surface is needed for this fixture.
  const demo = state as unknown as Parameters<typeof resetThroughBrowser>[0];

  return {
    demo,
    closePage,
    ready() {
      state.browser = { ...old, host: { runId: "new" } };
      state.state.phase = "ready";
    },
  };
}

for (const message of [
  "locator.click: Target page, context or browser has been closed",
  "locator.click: Browser closed",
]) {
  test(`reset accepts confirmed closure and waits for replacement: ${message}`, async () => {
    const fixture = resetFixture();
    let finished = false;
    const reset = resetThroughBrowser(fixture.demo, async () => {
      fixture.closePage();
      throw new Error(message);
    });
    const observed = reset.then(() => {
      finished = true;
    });

    // Avoid an unhandled rejection when running this against the old helper.
    observed.catch(() => {});

    try {
      await setImmediate();

      assert.equal(finished, false, "closure alone must not complete reset");
    } finally {
      fixture.ready();
    }

    await observed;

    assert.equal(finished, true);
  });
}

test("reset does not accept a closure message while the old page is open", async () => {
  const fixture = resetFixture();
  const error = new Error("locator.click: Browser closed");

  try {
    await assert.rejects(
      resetThroughBrowser(fixture.demo, async () => {
        throw error;
      }),
      (actual) => actual === error,
    );
  } finally {
    fixture.closePage();
  }
});

test("reset propagates other input failures even after page closure", async () => {
  const fixture = resetFixture();
  const error = new Error("locator.click: Timeout exceeded");

  await assert.rejects(
    resetThroughBrowser(fixture.demo, async () => {
      fixture.closePage();
      throw error;
    }),
    (actual) => actual === error,
  );
});
