import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { protectedService } from "./support/protected-service.js";
import { orderApplication } from "../../src/demos/orders/application.js";
import { orderConfiguration } from "../../src/demos/orders/configuration.js";
import { orderEvent } from "../../src/demos/orders/contracts.js";
import type { createProtectedOrderClient } from "../../../demos/order-tracker/src/protected.js";

declare global {
  interface Window {
    protectedOrder: ReturnType<typeof createProtectedOrderClient>;
    protectedOrderSockets: WebSocket[];
    protectedOrderClosed: number[];
    protectedOrderMessage: string;
  }
}
async function viewer(
  browser: Browser,
  origin: string,
  endpoint: string,
  credential: string,
  view: "order-tracking" | "order-summary",
) {
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
  await page.evaluate(
    async ({ endpoint, view }) => {
      const NativeSocket = window.WebSocket;
      window.protectedOrderSockets = [];
      window.protectedOrderClosed = [];
      window.WebSocket = class extends NativeSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          window.protectedOrderSockets.push(this);
          this.addEventListener("message", (event) => {
            if (JSON.parse(event.data).type === "view-update")
              window.protectedOrderMessage = event.data;
          });
          this.addEventListener("close", (event) =>
            window.protectedOrderClosed.push(event.code),
          );
        }
      };
      const { createProtectedOrderClient } =
        await import("/order-tracker/src/protected.js");
      window.protectedOrder = createProtectedOrderClient(endpoint, view);
      await window.protectedOrder.execute({ action: "connect" });
    },
    { endpoint, view },
  );
  return page;
}
async function subscribe(
  page: Page,
  viewId = "order-tracking",
  entityId = "order-1",
) {
  await page.evaluate(
    async ({ viewId, entityId }) =>
      window.protectedOrder.execute({ action: "subscribe", viewId, entityId }),
    { viewId, entityId },
  );
}
async function cleared(page: Page) {
  await page.waitForFunction(
    () => document.querySelectorAll("#tracking .tracking-facts").length === 0,
  );
  assert.doesNotMatch(
    await page.locator("main").innerText(),
    /ACCESS-|Arc desk lamp|Dispatched|Reserved/,
  );
}

test(
  "protected Order scope, revocation, clearing and fresh admission over HTTPS/WSS",
  { timeout: 90000 },
  async (t) => {
    const application = await orderApplication();
    const assets = new Map(application.assets);
    const html = assets.get("/")!;
    assets.set("/", [
      html[0],
      Buffer.from(
        html[1]
          .toString()
          .replace('<script src="startup.js"></script>', "")
          .replace("Continuous demo", "Protected access acceptance"),
      ),
    ]);
    const service = await protectedService(t, {
      configuration: orderConfiguration(),
      assets,
      permit: (request) =>
        request.operation === "authenticate" ||
        (request.credential.value === "tracking" &&
          request.resource?.viewId === "order-tracking" &&
          request.resource.entityId === "order-1") ||
        (request.credential.value === "operations" &&
          request.resource?.viewId === "order-summary"),
    });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    let sequence = 0;
    async function report() {
      const event = orderEvent(
        "orders",
        0,
        0,
        ++sequence,
        "dispatched",
        Date.now(),
      );
      event.payload.reference = `ACCESS-${sequence}`;
      await service.publishEvent(event);
    }
    await report();
    await service.publishEvent(
      orderEvent("inventory", 0, 0, 1, "reserved", Date.now()),
    );
    const tracking = await viewer(
      browser,
      service.origin,
      service.healthyUrl,
      "tracking",
      "order-tracking",
    );
    const operations = await viewer(
      browser,
      service.origin,
      service.healthyUrl,
      "operations",
      "order-summary",
    );
    await subscribe(tracking);
    await subscribe(operations, "order-summary");
    await tracking
      .locator('#tracking [data-field="inventory"] span')
      .filter({ hasText: "Reserved" })
      .waitFor();
    await operations
      .locator('#orders [data-order="order-1"] strong')
      .filter({ hasText: "ACCESS-1" })
      .waitFor();
    for (const [view, entity] of [
      ["order-tracking", "order-2"],
      ["order-summary", "order-1"],
    ]) {
      const denied = await viewer(
        browser,
        service.origin,
        service.healthyUrl,
        "tracking",
        "order-tracking",
      );
      await subscribe(denied);
      await assert.rejects(subscribe(denied, view, entity));
      await cleared(denied);
      await denied.close();
    }
    service.failures.set("tracking", "deny");
    let reporting = true;
    const publishing = (async () => {
      while (reporting) {
        await report();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();
    void publishing.catch(() => {});
    try {
      await tracking.waitForFunction(() =>
        window.protectedOrderClosed.includes(1008),
      );
      await cleared(tracking);
      const atLoss = sequence;
      await operations.waitForFunction(
        (n) =>
          Number(
            document
              .querySelector('#orders [data-order="order-1"] strong')
              ?.textContent?.match(/ACCESS-(\d+)/)?.[1],
          ) >=
          n + 2,
        atLoss,
      );
    } finally {
      reporting = false;
      await publishing;
    }
    await tracking.evaluate(() => {
      window.protectedOrderSockets[0].dispatchEvent(
        new MessageEvent("message", {
          data: window.protectedOrderMessage,
        }),
      );
    });
    await cleared(tracking);
    await assert.rejects(
      viewer(
        browser,
        service.origin,
        service.healthyUrl,
        "tracking",
        "order-tracking",
      ),
    );
    service.failures.delete("tracking");
    const recovered = await viewer(
      browser,
      service.origin,
      service.healthyUrl,
      "tracking",
      "order-tracking",
    );
    await subscribe(recovered);
    await recovered
      .locator('#tracking [data-field="inventory"] span')
      .filter({ hasText: "Reserved" })
      .waitFor();
    assert.equal(
      (
        (await recovered
          .locator("#tracking .technical dd")
          .filter({ hasText: "orders / order-1" })
          .textContent()) ?? ""
      ).endsWith(`publication ${sequence}`),
      true,
    );
    assert.ok(
      service.decisions.some(
        (d) =>
          d.credential === "tracking" &&
          d.viewId === "order-tracking" &&
          d.entityId === "order-2",
      ),
    );
    assert.ok(
      service.decisions.some(
        (d) => d.credential === "tracking" && d.viewId === "order-summary",
      ),
    );
  },
);
