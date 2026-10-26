import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadScenario } from "../../src/scenario.js";
import { playScenario } from "../../src/playback.js";
import { startZooGlassSession } from "../../src/zooglass-session.js";
import { startVehicleBrowserSession } from "../../src/vehicle-browser.js";
import { openScenarioSession } from "../../src/scenario-session.js";

test(
  "recovery fixture receives current snapshots after an explicit browser reconnect",
  { timeout: 90_000 },
  async () => {
    const scenario = await loadScenario(
      fileURLToPath(
        new URL(
          "../../scenarios/vehicle-browser-recovery.json",
          import.meta.url,
        ),
      ),
    );
    const service = await startZooGlassSession({ views: scenario.views });

    try {
      const browser = await startVehicleBrowserSession(service.baseUrl, {
        signal: service.signal,
        headless: true,
      });

      try {
        const session = await openScenarioSession(scenario, service.baseUrl, {
          signal: browser.signal,
          createClientExecutor: () => browser.host.executor,
        });

        try {
          // The fixture owns all actions and expectations, including the processing
          // barrier and both server checks before reconnect. No extra source sends.
          let reconnected = false;
          let initialSnapshots = 0;
          let disconnected = false;

          for (const entry of playScenario(scenario)) {
            if (entry.kind === "client-state" && entry.state === "disconnected")
              disconnected = true;

            if (
              disconnected &&
              entry.kind === "client-state" &&
              entry.state === "connected"
            )
              reconnected = true;

            if (reconnected) assert.notEqual(entry.kind, "source-event");

            await session.execute(entry);

            if (reconnected && entry.kind === "client-view-check")
              initialSnapshots++;
          }

          assert.equal(initialSnapshots, 2);
        } finally {
          await session.close();
        }
      } finally {
        await browser.close();
      }
    } finally {
      await service.close();
    }
  },
);
