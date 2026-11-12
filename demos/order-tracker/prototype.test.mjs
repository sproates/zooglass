import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import {
  chromium,
  webkit,
} from "../../workbench/node_modules/playwright/index.mjs";

let server;
let url;
before(async () => {
  server = createServer(async (request, response) => {
    const name =
      new URL(request.url, "http://localhost").pathname.slice(1) ||
      "index.html";
    if (!["index.html", "app.js", "fixtures.js", "styles.css"].includes(name)) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader(
      "Content-Type",
      name.endsWith(".js")
        ? "text/javascript"
        : name.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    response.end(
      await readFile(new URL(`./prototype/${name}`, import.meta.url)),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: order selection retains keyboard focus`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      await page.goto(url);
      for (const view of ["operations", "tracking"]) {
        await page.locator(`button[data-view="${view}"]`).click();
        const root = view === "operations" ? "#orders" : "#tracking";
        await page.locator(`${root} [data-order="1043"]`).focus();
        await page.keyboard.press("Enter");
        assert.equal(
          await page.evaluate(() => document.activeElement.dataset.order),
          "1043",
        );
        await page.keyboard.press(engine === webkit ? "Alt+Tab" : "Tab");
        assert.equal(
          await page.evaluate(() => document.activeElement.dataset.order),
          "1044",
        );
      }
    } finally {
      await browser.close();
    }
  });
  test(`${engine.name()}: phone dialog is named and returns focus`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      await page.goto(url);
      await page.locator('#orders [data-order="1046"]').focus();
      await page.keyboard.press("Enter");
      assert.equal(
        await page
          .getByRole("dialog", { name: "Order #1046 details", exact: true })
          .count(),
        1,
      );
      await page.keyboard.press("Escape");
      assert.equal(
        await page.evaluate(() => document.activeElement.dataset.order),
        "1046",
      );
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Close order details" }).click();
      assert.equal(
        await page.evaluate(() => document.activeElement.dataset.order),
        "1046",
      );
    } finally {
      await browser.close();
    }
  });
  test(`${engine.name()}: phone fixtures label age and courier authority`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      await page.goto(url);
      await page.locator(".review-tools > summary").click();
      await page.locator("#fixture").selectOption("mixed");
      await page.locator('#orders [data-order="1042"]').click();
      const facts = page.locator("#mobile-detail .detail-facts .field");
      assert.match(
        await facts.nth(1).innerText(),
        /Payment provider[\s\S]*Refunded[\s\S]*Previous cycle/,
      );
      assert.equal(
        await page
          .locator("#mobile-detail .field em")
          .first()
          .evaluate((el) => getComputedStyle(el).fontSize),
        "12px",
      );
      await page.keyboard.press("Escape");
      await page.locator("#fixture").selectOption("courier");
      await page.locator('#orders [data-order="1042"]').click();
      const detail = await page.locator("#mobile-detail").innerText();
      assert.match(detail, /Primary · selected[\s\S]*In transit · stale/);
      assert.match(detail, /Backup · not selected[\s\S]*Delivered · fresh/);
      assert.match(detail, /does not automatically switch authority/);
    } finally {
      await browser.close();
    }
  });
}
