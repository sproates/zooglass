import assert from "node:assert/strict";
import test from "node:test";
import { startVehicleBrowserSession } from "../../src/demos/vehicle/vehicle-browser.js";
import {
  peer,
  signal,
  state,
  subscription,
  position,
} from "./support/view-peer.js";

async function fixture(
  timeoutMs = 30_000,
  onRequest?: Parameters<typeof peer>[1],
) {
  const upstream = await peer(false, onRequest);
  const browser = await startVehicleBrowserSession(upstream.url, {
    signal: signal(),
    headless: true,
    keepOpenOnFailure: true,
  });
  const execute = (
    entry: ReturnType<typeof state> | ReturnType<typeof subscription>,
  ) => browser.host.executor.execute(entry, signal());
  await execute(state("connected"));
  for (const viewId of ["live-map", "trip-history"])
    await execute(subscription(viewId));
  upstream.snapshot("live-map", { position });
  upstream.snapshot("trip-history", { positions: [position] });
  await browser.page.locator("#history li").waitFor();
  browser.host.publish({ kind: "expect-data-fault", timeoutMs });
  await browser.page
    .locator("#activity li")
    .filter({ hasText: "recovery-armed" })
    .waitFor();
  const fault = (action: "break" | "restore") =>
    browser.host.controlDataConnection({
      runId: browser.host.runId,
      clientId: browser.host.clientId,
      action,
    });
  return {
    upstream,
    browser,
    execute,
    fault,
    async close() {
      await browser.close();
      await upstream.close();
    },
  };
}

for (const firstView of ["live-map", "trip-history"]) {
  test(
    `automatic recovery retries refused upgrades and waits for both snapshots (${firstView} first)`,
    { timeout: 20_000 },
    async () => {
      const f = await fixture();
      try {
        const page = f.browser.page;
        await f.fault("break");
        await page
          .locator("#activity li")
          .filter({ hasText: "retry-failed" })
          .waitFor();
        assert.match(
          await page.locator("#latest-status").innerText(),
          /Last received/,
        );
        assert.match(
          await page.locator("#connection-status").innerText(),
          /reconnecting/,
        );
        assert.equal(f.browser.signal.aborted, false);
        await f.fault("restore");
        await page
          .locator("#latest-status")
          .filter({ hasText: "waiting for a fresh snapshot" })
          .waitFor();
        await page
          .locator("#history-status")
          .filter({ hasText: "waiting for a fresh snapshot" })
          .waitFor();
        const next = { ...position, sequence: 43 };
        const send = (viewId: string) =>
          f.upstream.snapshot(
            viewId,
            viewId === "live-map"
              ? { position: next }
              : { positions: [position, next] },
          );
        send(firstView);
        const firstStatus =
          firstView === "live-map" ? "latest-status" : "history-status";
        await page.locator(`#${firstStatus}[data-state="received"]`).waitFor();
        assert.equal(
          await page
            .locator("#activity li")
            .filter({ hasText: "Recovery: recovered" })
            .count(),
          0,
        );
        send(firstView === "live-map" ? "trip-history" : "live-map");
        await page
          .locator("#activity li")
          .filter({ hasText: "Recovery: recovered" })
          .waitFor();
        assert.equal(await page.locator("#current-sequence").innerText(), "43");
        assert.equal(await page.locator("#history li").count(), 2);
        assert.equal(f.browser.signal.aborted, false);
      } finally {
        await f.close();
      }
    },
  );
}

test(
  "explicit disconnect cancels retries and permits a later manual connection",
  { timeout: 15_000 },
  async () => {
    const f = await fixture();
    try {
      await f.fault("break");
      await f.browser.page
        .locator("#activity li")
        .filter({ hasText: "retry-failed" })
        .waitFor();
      await f.execute(state("disconnected"));
      await f.fault("restore");
      await f.execute(state("connected"));
      await f.execute(subscription("live-map"));
      f.upstream.snapshot("live-map", { position });
      await f.browser.page
        .locator('#latest-status[data-state="received"]')
        .waitFor();
      assert.equal(f.browser.signal.aborted, false);
    } finally {
      await f.close();
    }
  },
);

test(
  "recovery deadline includes the outage and fails without snapshots",
  { timeout: 15_000 },
  async () => {
    const f = await fixture(800);
    try {
      await f.fault("break");
      await f.browser.page
        .locator("#connection-status")
        .filter({ hasText: "Recovery timed out" })
        .waitFor();
      assert.equal(f.browser.signal.aborted, true);
      assert.equal(f.browser.page.isClosed(), false);
    } finally {
      await f.close();
    }
  },
);

test(
  "disconnect cancels recovery while a subscription acknowledgement is withheld",
  { timeout: 15_000 },
  async () => {
    let hold = false;
    let entered!: () => void;
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = await fixture(30_000, (_request, acknowledge) => {
      if (hold) entered();
      else acknowledge();
    });
    try {
      hold = true;
      await f.fault("break");
      await f.fault("restore");
      await requested;
      await f.execute(state("disconnected"));
      assert.match(
        await f.browser.page.locator("#connection-status").innerText(),
        /disconnected/,
      );
      hold = false;
      await f.execute(state("connected"));
      await f.execute(subscription("live-map"));
      f.upstream.snapshot("live-map", { position });
      await f.browser.page
        .locator('#latest-status[data-state="received"]')
        .waitFor();
      assert.equal(f.browser.signal.aborted, false);
    } finally {
      await f.close();
    }
  },
);

test(
  "an open replacement connection cannot satisfy recovery without both snapshots",
  { timeout: 15_000 },
  async () => {
    const f = await fixture(1800);
    try {
      await f.fault("break");
      await f.fault("restore");
      await f.browser.page
        .locator("#latest-status")
        .filter({ hasText: "waiting for a fresh snapshot" })
        .waitFor();
      f.upstream.snapshot("live-map", { position });
      await f.browser.page
        .locator('#latest-status[data-state="received"]')
        .waitFor();
      await f.browser.page
        .locator("#connection-status")
        .filter({ hasText: "Recovery timed out" })
        .waitFor();
      assert.equal(
        await f.browser.page
          .locator("#activity li")
          .filter({ hasText: "Recovery: recovered" })
          .count(),
        0,
      );
      assert.equal(f.browser.signal.aborted, true);
    } finally {
      await f.close();
    }
  },
);
