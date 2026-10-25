import assert from "node:assert/strict";
import test from "node:test";
import {
  peer,
  signal,
  state,
  subscription,
  position,
} from "./support/view-peer.js";
import { startVehicleBrowserSession } from "../../src/vehicle-browser.js";

test(
  "independent waiting and empty states, retained data, and fresh snapshots after resubscription",
  { timeout: 30_000 },
  async () => {
    const upstream = await peer();
    try {
      const browser = await startVehicleBrowserSession(upstream.url, {
        signal: signal(),
        headless: true,
        keepOpenOnFailure: true,
      });
      try {
        const execute = (
          entry: ReturnType<typeof state> | ReturnType<typeof subscription>,
        ) => browser.host.executor.execute(entry, signal());
        await execute(state("connected"));
        await execute(subscription("live-map"));
        await execute(subscription("trip-history"));
        await browser.page
          .locator("#latest-status")
          .filter({ hasText: "waiting for first snapshot" })
          .waitFor();
        await browser.page
          .locator("#history-status")
          .filter({ hasText: "waiting for first snapshot" })
          .waitFor();
        upstream.snapshot("live-map", { position });
        await browser.page
          .locator("#current-sequence")
          .filter({ hasText: "42" })
          .waitFor();
        assert.match(
          await browser.page.locator("#history-status").innerText(),
          /waiting for first snapshot/,
        );
        upstream.snapshot("trip-history", { positions: [] });
        await browser.page
          .locator("#history-status")
          .filter({ hasText: "empty snapshot" })
          .waitFor();
        assert.equal(await browser.page.locator("#history li").count(), 0);
        upstream.snapshot("trip-history", { positions: [position] });
        await browser.page.locator("#history li").waitFor();
        await execute(state("disconnected"));
        assert.match(
          await browser.page.locator("#position-label").innerText(),
          /Last received/i,
        );
        assert.match(
          await browser.page.locator("#latest-status").innerText(),
          /Last received.*disconnected/,
        );
        assert.match(
          await browser.page.locator("#history-status").innerText(),
          /Last received.*disconnected/,
        );
        assert.equal(await browser.page.locator("#history li").count(), 1);
        await execute(state("connected"));
        await execute(subscription("live-map"));
        await execute(subscription("trip-history"));
        assert.match(
          await browser.page.locator("#latest-status").innerText(),
          /waiting for a fresh snapshot/,
        );
        upstream.snapshot("live-map", { position });
        await browser.page
          .locator("#latest-status")
          .filter({ hasText: "Latest snapshot received" })
          .waitFor();
        assert.match(
          await browser.page.locator("#history-status").innerText(),
          /waiting for a fresh snapshot/,
        );
        upstream.snapshot("trip-history", { positions: [position] });
        await browser.page
          .locator("#history-status")
          .filter({ hasText: "1 received position" })
          .waitFor();
        await execute(subscription("live-map", "unsubscribe"));
        assert.match(
          await browser.page.locator("#latest-status").innerText(),
          /Last received.*not subscribed/,
        );
        assert.match(
          await browser.page.locator("#history-status").innerText(),
          /1 received position/,
        );
        upstream.disconnect();
        await browser.page
          .locator("#connection-status")
          .filter({ hasText: "connection failed" })
          .waitFor();
        await browser.page
          .locator("#status")
          .filter({ hasText: "run failed" })
          .waitFor();
        assert.equal(browser.signal.aborted, true);
        assert.equal(
          browser.page.isClosed(),
          false,
          "Keep the failed page available for inspection.",
        );
        await assert.rejects(execute(state("connected")));
        assert.match(
          await browser.page.locator("#history-status").innerText(),
          /Last received.*connection failed/,
        );
        await browser.page.screenshot({
          path: "/tmp/zooglass-connection-failed.png",
          fullPage: true,
        });
      } finally {
        await browser.close();
      }
    } finally {
      await upstream.close();
    }
  },
);

test(
  "a failed connection is visible even before any snapshot exists",
  { timeout: 30_000 },
  async () => {
    const upstream = await peer(true);
    try {
      const browser = await startVehicleBrowserSession(upstream.url, {
        signal: signal(),
        headless: true,
        keepOpenOnFailure: true,
      });
      try {
        await assert.rejects(
          browser.host.executor.execute(state("connected"), signal()),
        );
        await browser.page
          .locator("#connection-status")
          .filter({ hasText: "Could not connect" })
          .waitFor();
        assert.match(
          await browser.page.locator("#latest-status").innerText(),
          /No snapshot received.*connection failed/,
        );
        assert.match(
          await browser.page.locator("#history-status").innerText(),
          /No snapshot received.*connection failed/,
        );
      } finally {
        await browser.close();
      }
    } finally {
      await upstream.close();
    }
  },
);
