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
  test(`${engine.name()}: match selection retains keyboard focus`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      await page.goto(url);
      await page.locator('[data-match="02"]').focus();
      await page.keyboard.press("Enter");
      assert.equal(
        await page.evaluate(() => document.activeElement.dataset.match),
        "02",
      );
      await page.keyboard.press(engine === webkit ? "Alt+Tab" : "Tab");
      assert.equal(
        await page.evaluate(() => document.activeElement.dataset.match),
        "03",
      );
    } finally {
      await browser.close();
    }
  });
  test(`${engine.name()}: odds stay inside the market at responsive boundaries`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url);
      for (const width of [
        360, 390, 650, 651, 700, 760, 768, 900, 1024, 1440,
      ]) {
        await page.setViewportSize({ width, height: 1000 });
        const bounds = await page.evaluate(() => ({
          page: document.documentElement.scrollWidth,
          panel: document.getElementById("market").getBoundingClientRect()
            .right,
          odds: [...document.querySelectorAll(".odds > div")].map(
            (el) => el.getBoundingClientRect().right,
          ),
        }));
        assert.ok(
          bounds.page <= width,
          `page overflows at ${width}px: ${bounds.page}`,
        );
        assert.ok(
          bounds.odds.every((right) => right < bounds.panel - 10),
          `odds escape panel padding at ${width}px`,
        );
      }
    } finally {
      await browser.close();
    }
  });
  test(`${engine.name()}: phone detail navigation and market states`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      await page.goto(url);
      const suspendedColour = await page
        .locator(".market-state")
        .evaluate((el) => getComputedStyle(el).color);
      for (const view of ["board", "comparison"]) {
        await page.locator(`[data-view="${view}"]`).click();
        await page.locator('[data-match="02"]').focus();
        await page.keyboard.press("Enter");
        const target = view === "board" ? "match-detail" : "comparison";
        assert.equal(
          await page.evaluate(() => document.activeElement.id),
          target,
        );
        await page.locator(`#${target} [data-back-to-matches]`).click();
        assert.equal(
          await page.evaluate(() => document.activeElement.dataset.match),
          "02",
        );
      }
      await page.locator('[data-view="board"]').click();
      const openColour = await page
        .locator(".market-state")
        .evaluate((el) => getComputedStyle(el).color);
      assert.notEqual(suspendedColour, openColour);
      assert.doesNotMatch(
        await page.locator(".goals").innerText(),
        /birth|revision/,
      );
      await page.locator("#match-detail .rules summary").click();
      assert.match(
        await page.locator("#match-detail .rules").innerText(),
        /birth 4 · revision 1/,
      );
    } finally {
      await browser.close();
    }
  });
}
