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

// Keep actual sockets and dispatch late callbacks explicitly: a closed network
// connection alone cannot reliably reproduce a callback already queued by an old socket.
async function retainDataSockets(
  page: Awaited<ReturnType<typeof startVehicleBrowserSession>>["page"],
) {
  await page.evaluate(() => {
    const sockets: WebSocket[] = [];
    Object.assign(window, { testDataSockets: sockets });
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).includes("/views/live")) sockets.push(this);
      }
    };
  });
}

for (const firstView of ["live-map", "trip-history"]) {
  test(
    `reconnect accepts ${firstView} first and ignores old socket callbacks`,
    { timeout: 30_000 },
    async (t) => {
      const upstream = await peer();
      t.after(() => upstream.close());
      const browser = await startVehicleBrowserSession(upstream.url, {
        signal: signal(),
        headless: true,
      });
      try {
        await retainDataSockets(browser.page);
        const execute = (
          entry: ReturnType<typeof state> | ReturnType<typeof subscription>,
        ) => browser.host.executor.execute(entry, signal());
        const subscribeBoth = async () => {
          await execute(subscription("live-map"));
          await execute(subscription("trip-history"));
        };
        await execute(state("connected"));
        await subscribeBoth();
        upstream.snapshot("live-map", { position });
        upstream.snapshot("trip-history", { positions: [position] });
        await browser.page
          .locator('#latest-status[data-state="received"]')
          .waitFor();
        await browser.page
          .locator('#history-status[data-state="received"]')
          .waitFor();
        await execute(state("disconnected"));
        await execute(state("connected"));
        await subscribeBoth();

        // All four callback kinds from the old generation must be harmless.
        await browser.page.evaluate(() => {
          const old = (window as unknown as { testDataSockets: WebSocket[] })
            .testDataSockets[0];
          old.dispatchEvent(new Event("open"));
          old.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "view-update",
                viewId: "live-map",
                entityId: "car-17",
                data: {
                  position: { sequence: 999, latitude: 0, longitude: 0 },
                },
              }),
            }),
          );
          old.dispatchEvent(new Event("error"));
          old.dispatchEvent(new CloseEvent("close"));
          if (document.querySelector("#current-sequence")!.textContent !== "42")
            throw new Error("Old socket overwrote retained position");
          for (const id of ["latest-status", "history-status"])
            if (document.getElementById(id)!.dataset.state !== "retained")
              throw new Error("Old socket changed freshness");
        });
        const fresh = { ...position, sequence: 43 };
        upstream.snapshot(
          firstView,
          firstView === "live-map"
            ? { position: fresh }
            : { positions: [position, fresh] },
        );
        const firstStatus =
          firstView === "live-map" ? "latest-status" : "history-status";
        const secondStatus =
          firstView === "live-map" ? "history-status" : "latest-status";
        await browser.page
          .locator(`#${firstStatus}[data-state="received"]`)
          .waitFor();
        assert.match(
          await browser.page.locator(`#${secondStatus}`).innerText(),
          /waiting for a fresh snapshot/,
        );
        upstream.snapshot(
          firstView === "live-map" ? "trip-history" : "live-map",
          firstView === "live-map"
            ? { positions: [position, fresh] }
            : { position: fresh },
        );
        await browser.page
          .locator(`#${secondStatus}[data-state="received"]`)
          .waitFor();
        assert.equal(browser.signal.aborted, false);
        assert.equal(
          await browser.page.locator("#current-sequence").innerText(),
          "43",
        );
        assert.equal(await browser.page.locator("#history li").count(), 2);
      } finally {
        await browser.close();
      }
    },
  );
}

test(
  "a missing snapshot remains pending and closing the session cancels its check",
  { timeout: 30_000 },
  async (t) => {
    const upstream = await peer();
    t.after(() => upstream.close());
    const browser = await startVehicleBrowserSession(upstream.url, {
      signal: signal(),
      headless: true,
    });
    try {
      await browser.host.executor.execute(state("connected"), signal());
      await browser.host.executor.execute(
        subscription("trip-history"),
        signal(),
      );
      const pending = browser.host.executor.execute(
        {
          kind: "client-view-check",
          simulationTime: 0,
          clientId: "rider-app",
          clientName: "Viewer",
          viewId: "trip-history",
          entityId: "car-17",
          expected: { positions: [position] },
        },
        signal(),
      );
      const rejected = assert.rejects(pending);
      assert.match(
        await browser.page.locator("#history-status").innerText(),
        /waiting for first snapshot/,
      );
      await browser.close();
      await rejected;
      assert.equal(browser.page.isClosed(), true);
    } finally {
      await browser.close();
    }
  },
);

test(
  "updates before unsubscribe acknowledgement remain valid; resubscribe waits for fresh data",
  { timeout: 30_000 },
  async (t) => {
    let acknowledgeUnsubscribe!: () => void;
    let entered!: () => void;
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const upstream = await peer(false, (request, acknowledge) => {
      if (request.action === "unsubscribe") {
        acknowledgeUnsubscribe = acknowledge;
        entered();
      } else acknowledge();
    });
    t.after(() => upstream.close());
    const browser = await startVehicleBrowserSession(upstream.url, {
      signal: signal(),
      headless: true,
    });
    try {
      const execute = (
        entry: ReturnType<typeof state> | ReturnType<typeof subscription>,
      ) => browser.host.executor.execute(entry, signal());
      await execute(state("connected"));
      await execute(subscription("live-map"));
      upstream.snapshot("live-map", { position });
      await browser.page
        .locator('#latest-status[data-state="received"]')
        .waitFor();
      const unsubscribe = execute(subscription("live-map", "unsubscribe"));
      await requested;
      upstream.snapshot("live-map", {
        position: { ...position, sequence: 43 },
      });
      await browser.page
        .locator("#current-sequence")
        .filter({ hasText: "43" })
        .waitFor();
      acknowledgeUnsubscribe();
      await unsubscribe;
      assert.match(
        await browser.page.locator("#latest-status").innerText(),
        /not subscribed/,
      );
      await execute(subscription("live-map"));
      assert.match(
        await browser.page.locator("#latest-status").innerText(),
        /waiting for a fresh snapshot/,
      );
      upstream.snapshot("live-map", {
        position: { ...position, sequence: 44 },
      });
      await browser.page
        .locator("#current-sequence")
        .filter({ hasText: "44" })
        .waitFor();
      assert.equal(
        await browser.page.locator("#latest-status").getAttribute("data-state"),
        "received",
      );
      assert.equal(browser.signal.aborted, false);
    } finally {
      await browser.close();
    }
  },
);

for (const action of ["subscribe", "unsubscribe"] as const) {
  test(
    `connection loss while ${action} acknowledgement is pending rejects the operation`,
    { timeout: 30_000 },
    async (t) => {
      let entered!: () => void;
      const requested = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const upstream = await peer(false, (request, acknowledge) => {
        if (request.action === action) entered();
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
        if (action === "unsubscribe")
          await browser.host.executor.execute(
            subscription("live-map"),
            signal(),
          );
        const pending = browser.host.executor.execute(
          subscription("live-map", action),
          signal(),
        );
        const rejected = assert.rejects(pending);
        await requested;
        upstream.disconnect();
        await rejected;
        await browser.page
          .locator("#connection-status")
          .filter({ hasText: "connection failed" })
          .waitFor();
        assert.equal(browser.signal.aborted, true);
        assert.equal(browser.page.isClosed(), false);
        await assert.rejects(
          browser.host.executor.execute(state("connected"), signal()),
        );
      } finally {
        await browser.close();
      }
    },
  );
}
