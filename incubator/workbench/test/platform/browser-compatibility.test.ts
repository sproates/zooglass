import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";
import { startVehicleBrowserHost } from "../../src/vehicle/vehicle-browser.js";
import { startZooGlassSession } from "../../src/zooglass-session.js";
import { loadScenario } from "../../src/scenario.js";
import { openScenarioSession } from "../../src/scenario-session.js";
import { playScenario } from "../../src/playback.js";
import { observeVehicleSession } from "../../src/vehicle/vehicle-observer.js";

const engines = { chromium, firefox, webkit };

const name = process.env.WORKBENCH_TEST_ENGINE ?? "chromium";

assert.ok(name in engines, `Unknown browser engine: ${name}`);

const engine = engines[name as keyof typeof engines];

test(
  `${name}: real recovery receipts and rendered state`,
  { timeout: 90_000 },
  async (t) => {
    const scenario = await loadScenario(
      fileURLToPath(
        new URL(
          "../../scenarios/vehicle-browser-recovery.json",
          import.meta.url,
        ),
      ),
    );
    const service = await startZooGlassSession({ views: scenario.views });
    const resources: { close(): Promise<void> }[] = [service];

    t.after(async () => {
      const errors: unknown[] = [];
      for (const resource of resources) {
        try {
          await resource.close();
        } catch (error) {
          errors.push(error);
        }
      }

      if (errors.length)
        throw new AggregateError(errors, "Compatibility test cleanup failed");
    });

    const host = await startVehicleBrowserHost(service.baseUrl);

    resources.unshift(host);

    const browser = await engine.launch({ headless: true });

    resources.unshift(browser);

    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors: string[] = [];

    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(host.pageUrl);
    await host.waitForReady(service.signal);
    // Start after registration so the initial URL token isn't captured in the trace.
    await context.tracing.start({ screenshots: true, snapshots: true });

    try {
      const session = await openScenarioSession(scenario, service.baseUrl, {
        signal: host.signal,
        createClientExecutor(client) {
          assert.equal(client.id, host.clientId);
          return host.executor;
        },
      });

      resources.unshift(session);

      const observed = observeVehicleSession(session, page, host.signal);

      for (const entry of playScenario(scenario)) await observed.execute(entry);

      assert.deepEqual(pageErrors, []);
      await context.tracing.stop();
    } catch (error) {
      await mkdir("test-results", { recursive: true });
      await Promise.allSettled([
        page.screenshot({
          path: `test-results/${name}-failure.png`,
          fullPage: true,
        }),
        context.tracing.stop({ path: `test-results/${name}-trace.zip` }),
      ]);
      t.diagnostic(JSON.stringify({ engine: name, pageErrors }));
      throw error;
    }
  },
);
