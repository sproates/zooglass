import assert from "node:assert/strict";
import test from "node:test";
import { startVehicleBrowserSession } from "../../src/vehicle-browser.js";
import {
  peer,
  signal,
  state,
  subscription,
  position,
} from "./support/view-peer.js";

const ack = { type: "subscribed", viewId: "live-map", entityId: "car-17" };
const cases: [string, string[], string][] = [
  ["malformed JSON", ["{"], "connection failed"],
  [
    "wrong entity acknowledgement",
    [JSON.stringify({ ...ack, entityId: "other" })],
    "Unexpected subscription response",
  ],
  [
    "wrong view acknowledgement",
    [JSON.stringify({ ...ack, viewId: "trip-history" })],
    "Unexpected subscription response",
  ],
  [
    "wrong action acknowledgement",
    [JSON.stringify({ ...ack, type: "unsubscribed" })],
    "Unexpected subscription response",
  ],
  [
    "duplicate acknowledgement",
    [JSON.stringify(ack), JSON.stringify(ack)],
    "Unexpected subscription response",
  ],
  [
    "snapshot before acknowledgement",
    [
      JSON.stringify({
        type: "view-update",
        viewId: "live-map",
        entityId: "car-17",
        data: { position },
      }),
    ],
    "Unexpected ZooGlass message",
  ],
];
for (const [name, responses, expected] of cases) {
  test(
    `${name} fails the browser run; a fresh session still works`,
    { timeout: 30_000 },
    async (t) => {
      let bad = true;
      const upstream = await peer(false, (_request, acknowledge) => {
        if (bad) for (const response of responses) upstream.raw(response);
        else acknowledge();
      });
      t.after(() => upstream.close());
      const browser = await startVehicleBrowserSession(upstream.url, {
        signal: signal(),
        headless: true,
        keepOpenOnFailure: true,
      });
      try {
        await browser.host.executor.execute(state("connected"), signal());
        // A duplicate may follow successful completion of the first ack. The run
        // must fail either way; success of that one command is not run success.
        await browser.host.executor
          .execute(subscription("live-map"), signal())
          .catch(() => {});
        await browser.page
          .locator("#connection-status")
          .filter({ hasText: expected })
          .waitFor();
        await browser.page
          .locator("#status")
          .filter({ hasText: "run failed" })
          .waitFor();
        assert.equal(browser.signal.aborted, true);
        assert.equal(browser.page.isClosed(), false);
        await assert.rejects(
          browser.host.executor.execute(subscription("trip-history"), signal()),
        );
      } finally {
        await browser.close();
      }
      bad = false;
      const fresh = await startVehicleBrowserSession(upstream.url, {
        signal: signal(),
        headless: true,
      });
      try {
        await fresh.host.executor.execute(state("connected"), signal());
        await fresh.host.executor.execute(subscription("live-map"), signal());
        upstream.snapshot("live-map", { position });
        await fresh.host.executor.execute(
          {
            kind: "client-view-check",
            simulationTime: 0,
            clientId: "rider-app",
            clientName: "Viewer",
            viewId: "live-map",
            entityId: "car-17",
            expected: { position },
          },
          signal(),
        );
        assert.equal(fresh.signal.aborted, false);
      } finally {
        await fresh.close();
      }
    },
  );
}

test(
  "missing acknowledgement times out, fails the run and closes on caller cancellation",
  { timeout: 20_000 },
  async (t) => {
    const upstream = await peer(false, () => {});
    t.after(() => upstream.close());
    const lifetime = new AbortController();
    const browser = await startVehicleBrowserSession(upstream.url, {
      signal: lifetime.signal,
      headless: true,
      keepOpenOnFailure: true,
    });
    try {
      await browser.host.executor.execute(state("connected"), signal());
      await assert.rejects(
        browser.host.executor.execute(subscription("live-map"), signal()),
        { name: "AbortError" },
      );
      assert.equal(browser.signal.aborted, true);
      const closed = browser.page.waitForEvent("close");
      lifetime.abort(new Error("Test caller stopped"));
      await closed;
    } finally {
      await browser.close();
    }
  },
);
