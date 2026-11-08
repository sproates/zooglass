import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { protectedService } from "./support/protected-service.js";
import type { createVehicleClient } from "../../../demos/vehicle-tracker/src/vehicle-client.js";

declare global {
  interface Window {
    acceptanceClient: ReturnType<typeof createVehicleClient>;
    acceptanceSockets: WebSocket[];
    acceptanceClosed: number[];
  }
}

async function viewer(
  browser: Browser,
  origin: string,
  endpoint: string,
  credential: string,
) {
  // Only this generated-certificate test context relaxes browser certificate trust.
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([
    {
      name: "session",
      value: credential,
      url: origin,
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  await page.goto(origin);
  await page.evaluate(async (endpoint) => {
    const NativeSocket = window.WebSocket;
    window.acceptanceSockets = [];
    window.acceptanceClosed = [];
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        window.acceptanceSockets.push(this);
        this.addEventListener("close", (event) =>
          window.acceptanceClosed.push(event.code),
        );
      }
    };
    // Load the shipped demo client and view, not a replacement rendering fixture.
    const { createVehicleClient } = await import("/dist/vehicle-client.js");
    window.acceptanceClient = createVehicleClient(
      endpoint,
      () => {},
      () => {},
      { protectedViews: true },
    );
  }, endpoint);
  return page;
}

async function subscribe(page: Page) {
  return page.evaluate(async () => {
    await window.acceptanceClient.execute({ action: "connect" });
    for (const viewId of ["live-map", "trip-history"]) {
      await window.acceptanceClient.execute({
        action: "subscribe",
        viewId,
        entityId: "car-17",
      });
    }
  });
}

async function position(page: Page, sequence: number) {
  await page
    .locator("#current-sequence")
    .filter({ hasText: String(sequence) })
    .waitFor();
  await page
    .locator("#history li")
    .filter({ hasText: `Position ${sequence} ·` })
    .waitFor();
}

async function cleared(page: Page) {
  await page.waitForFunction(
    () => document.getElementById("current-sequence")?.textContent === "—",
  );
  assert.equal(await page.locator("#vehicle-marker").getAttribute("cx"), null);
  assert.equal(await page.locator("#vehicle-marker").getAttribute("cy"), null);
  assert.equal(await page.locator("#history li").count(), 0);
  assert.equal(await page.locator("#route-line").getAttribute("points"), "");
  assert.equal(
    await page.locator("#vehicle-marker").getAttribute("visibility"),
    "hidden",
  );
  assert.equal(
    await page.locator("#current-coordinates").innerText(),
    "No position received",
  );
  assert.doesNotMatch(
    await page.locator("#route-description").innerText(),
    /51\.200/,
  );
}

async function staleCallbacks(page: Page) {
  await page.evaluate(() => {
    const old = window.acceptanceSockets[0];
    old.dispatchEvent(new Event("open"));
    old.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "view-update",
          viewId: "live-map",
          entityId: "car-17",
          data: { position: { sequence: 999, latitude: 0, longitude: 0 } },
        }),
      }),
    );
    old.dispatchEvent(new Event("error"));
    old.dispatchEvent(new CloseEvent("close"));
  });
}

for (const failure of ["deny", "unauthenticated", "unavailable"] as const) {
  test(
    `protected demo clears ${failure} during publication and requires fresh admission`,
    { timeout: 90_000 },
    async (t) => {
      const service = await protectedService(t);
      const browser = await chromium.launch();
      t.after(() => browser.close());
      await service.publish(42);
      const page = await viewer(
        browser,
        service.origin,
        service.viewerUrl,
        "viewer",
      );
      const healthy = await viewer(
        browser,
        service.origin,
        service.healthyUrl,
        "healthy",
      );
      const denied = await viewer(
        browser,
        service.origin,
        service.viewerUrl,
        "denied",
      );
      await subscribe(page);
      await subscribe(healthy);
      await position(page, 42);
      await assert.rejects(subscribe(denied));
      await cleared(denied);

      service.failures.set("viewer", failure);
      let reporting = true;
      let latest = 42;
      const publications = (async () => {
        while (reporting) {
          await service.publish(++latest);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      })();
      // Attach rejection handling while the page independently observes access loss.
      void publications.catch(() => {});
      try {
        await page
          .locator("#connection-status")
          .filter({ hasText: "connection failed" })
          .waitFor();
        await cleared(page);
        const sequenceAtLoss = latest;
        await healthy.waitForFunction(
          (sequence) =>
            Number(document.getElementById("current-sequence")?.textContent) >=
            sequence,
          sequenceAtLoss + 2,
          { timeout: 5000 },
        );
        assert.ok(
          (await page.evaluate(() => window.acceptanceClosed)).includes(1008),
        );
      } finally {
        reporting = false;
        await publications;
      }
      assert.ok(
        latest > 42,
        "source kept publishing during the permission change",
      );
      await position(healthy, latest);
      await staleCallbacks(page);
      await cleared(page);

      // A new socket cannot reuse the previous connection's grants.
      // Failed clients are replaced, as when the app begins a fresh authenticated session.
      await page.reload();
      await page.evaluate(async (endpoint) => {
        const { createVehicleClient } = await import("/dist/vehicle-client.js");
        window.acceptanceClient = createVehicleClient(
          endpoint,
          () => {},
          () => {},
          { protectedViews: true },
        );
      }, service.viewerUrl);
      await assert.rejects(subscribe(page));
      await cleared(page);

      service.failures.delete("viewer");
      const recovered = await viewer(
        browser,
        service.origin,
        service.viewerUrl,
        "viewer",
      );
      await cleared(recovered);
      const previousReads = service.decisions.filter(
        (d) => d.credential === "viewer" && d.operation === "read",
      ).length;
      await subscribe(recovered);
      await position(recovered, latest);
      assert.ok(
        service.decisions.filter(
          (d) => d.credential === "viewer" && d.operation === "read",
        ).length >=
          previousReads + 2,
      );
    },
  );
}

test(
  "protected demo clears deliberate and abnormal losses, rejects stale callbacks and recovers from a new baseline",
  { timeout: 90_000 },
  async (t) => {
    const service = await protectedService(t);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    await service.publish(42);
    const page = await viewer(
      browser,
      service.origin,
      service.viewerUrl,
      "viewer",
    );
    await subscribe(page);
    await position(page, 42);
    await page.evaluate(() =>
      window.acceptanceClient.execute({ action: "disconnect" }),
    );
    await cleared(page);
    await staleCallbacks(page);
    await cleared(page);
    await service.publish(43);
    await subscribe(page);
    await position(page, 43);
    await staleCallbacks(page);
    await position(page, 43);

    await page.evaluate(() => window.acceptanceClient.expectRecovery());
    service.interrupt();
    await cleared(page);
    assert.ok(
      (await page.evaluate(() => window.acceptanceClosed)).includes(1006),
    );
    await service.publish(44);
    service.restore();
    await position(page, 44);
    await page.evaluate(() => window.acceptanceClient.close());
    await cleared(page);

    const outcome = await page.evaluate(async (endpoint) => {
      const { createVehicleClient } = await import("/dist/vehicle-client.js");
      const client = createVehicleClient(
        endpoint,
        () => {},
        () => {},
        { protectedViews: true },
      );
      const pending = client.execute({ action: "connect" }).then(
        () => "resolved",
        () => "rejected",
      );
      client.close();
      let timer: ReturnType<typeof setTimeout>;
      try {
        return await Promise.race([
          pending,
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve("pending"), 2000);
          }),
        ]);
      } finally {
        clearTimeout(timer!);
      }
    }, service.viewerUrl);
    assert.equal(outcome, "rejected");
  },
);
