import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { startApplicationHost } from "../../src/browser/browser-host.js";
import { launchOwnedBrowser } from "../../src/browser/owned-browser.js";
import { state, signal } from "./support/view-peer.js";

test(
  "late client completions and observations cannot cross a bridge run change",
  { timeout: 20_000 },
  async () => {
    const host = await startApplicationHost({
      application: {
        clientId: "rider-app",
        assets: new Map([
          [
            "/",
            [
              "text/html",
              Buffer.from('<script type="module" src="/fixture.js"></script>'),
            ],
          ],
          [
            "/bridge.js",
            [
              "text/javascript",
              await readFile(
                new URL("../../browser/bridge.js", import.meta.url),
              ),
            ],
          ],
          [
            "/fixture.js",
            [
              "text/javascript",
              await readFile(
                new URL(
                  "../fixtures/browser/run-replacement.js",
                  import.meta.url,
                ),
              ),
            ],
          ],
        ]),
      },
    });
    let browser: Awaited<ReturnType<typeof launchOwnedBrowser>> | undefined;
    try {
      const first = await host.replaceRun("http://127.0.0.1:1");
      browser = await launchOwnedBrowser(host.pageUrl, {
        headless: true,
        signal: host.signal,
      });
      const page = browser.page;
      await first.waitForReady(signal());
      const abandoned = assert.rejects(
        first.executor.execute(state("connected"), signal()),
      );
      await page.waitForFunction("typeof clients[0].complete === 'function'");
      const next = await host.replaceRun("http://127.0.0.1:1");
      await next.waitForReady(signal());
      await abandoned;
      assert.equal(await page.evaluate("clients[0].closed"), true);
      let completed = false;
      const command = next.executor
        .execute(state("connected"), signal())
        .then(() => {
          completed = true;
        });
      await page.waitForFunction("typeof clients[1].complete === 'function'");
      await page.evaluate(`clients[0].complete(99);
      clients[0].report({ type: 'observation', event: 'opened', connectionGeneration: 99, observationIndex: 99 });
      clients[1].report({ type: 'observation', event: 'opened', connectionGeneration: 1, observationIndex: 1 });`);
      // The current observation is a wire-order barrier for any incorrectly forwarded old receipt.
      await next.observations.wait("opened", 0, signal(), 2_000);
      assert.equal(next.observations.cursor(), 1);
      assert.equal(next.signal.aborted, false);
      assert.equal(completed, false);
      await page.evaluate("clients[1].complete(1)");
      await command;
      assert.equal(completed, true);
    } finally {
      await browser?.close();
      await host.close();
    }
  },
);
