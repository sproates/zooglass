import { observeVehicleSession } from "../../src/demos/vehicle/vehicle-observer.js";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startZooGlassSession } from "../../src/service/zooglass-session.js";
import { startVehicleBrowserSession } from "../../src/demos/vehicle/vehicle-browser.js";
import { openScenarioSession } from "../../src/execution/scenario-session.js";
import { playScenario } from "../../src/scenario/playback.js";
import { loadScenario } from "../../src/scenario/scenario.js";

for (const variant of ["basic", "journey"]) {
  const fixture = fileURLToPath(
    new URL(`../../scenarios/vehicle-browser-${variant}.json`, import.meta.url),
  );

  test(
    `${variant} drives both rendered browser views through actual subscriptions`,
    { timeout: 90_000 },
    async () => {
      const scenario = await loadScenario(fixture);
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
          const observed = observeVehicleSession(
            session,
            browser.page,
            browser.signal,
          );

          try {
            assert.equal(
              await browser.page.locator("#current-sequence").textContent(),
              "—",
            );
            assert.equal(await browser.page.locator("#history li").count(), 0);
            for (const entry of playScenario(scenario)) {
              await observed.execute(entry);

              if (entry.kind !== "client-view-check") continue;
              if (entry.viewId === "live-map") {
                const p = entry.expected.position as {
                  sequence: number;
                  latitude: number;
                  longitude: number;
                };

                assert.equal(
                  await browser.page.locator("#current-sequence").textContent(),
                  String(p.sequence),
                );
                assert.equal(
                  await browser.page
                    .locator("#current-coordinates")
                    .textContent(),
                  `${p.latitude.toFixed(3)}, ${p.longitude.toFixed(3)}`,
                );

                const marker = browser.page.locator("#vehicle-marker");

                assert.equal(
                  await marker.getAttribute("visibility"),
                  "visible",
                );
                assert.ok(
                  Math.abs(
                    Number(await marker.getAttribute("cx")) -
                      (60 + ((p.longitude + 0.35) / 0.4) * 480),
                  ) < 0.001,
                );
                assert.ok(
                  Math.abs(
                    Number(await marker.getAttribute("cy")) -
                      (270 - ((p.latitude - 50.95) / 0.4) * 220),
                  ) < 0.001,
                );
              } else {
                const positions = entry.expected.positions as {
                  sequence: number;
                  latitude: number;
                  longitude: number;
                }[];

                if (variant === "journey" && positions.length === 3) {
                  // History receipt proves delayed 41 was processed; latest must remain 42.
                  assert.equal(
                    await browser.page
                      .locator("#current-sequence")
                      .textContent(),
                    "42",
                  );
                  assert.ok(
                    Math.abs(
                      Number(
                        await browser.page
                          .locator("#vehicle-marker")
                          .getAttribute("cx"),
                      ) - 180,
                    ) < 0.001,
                  );
                }

                assert.deepEqual(
                  await browser.page.locator("#history li").allTextContents(),
                  positions.map(
                    (p) =>
                      `Position ${p.sequence} · ${p.latitude.toFixed(3)}, ${p.longitude.toFixed(3)}`,
                  ),
                );
                assert.equal(
                  (
                    await browser.page
                      .locator("#route-line")
                      .getAttribute("points")
                  )?.split(" ").length,
                  positions.length,
                );
              }
            }
            await browser.page.screenshot({
              path: `/tmp/zooglass-vehicle-${variant}-desktop.png`,
              fullPage: true,
            });
            await browser.page.setViewportSize({ width: 390, height: 844 });
            await browser.page.screenshot({
              path: `/tmp/zooglass-vehicle-${variant}-mobile.png`,
              fullPage: true,
            });

            assert.equal(
              await browser.page.evaluate(() => {
                const page = globalThis as unknown as {
                  document: { documentElement: { scrollWidth: number } };
                  innerWidth: number;
                };
                return (
                  page.document.documentElement.scrollWidth <= page.innerWidth
                );
              }),
              true,
            );

            // Resubscribing receives the same full snapshots. History must be replaced, not appended.
            const subscriptions = scenario.timeline.filter(
              (entry) => entry.kind === "client-subscription",
            );

            for (const entry of subscriptions) {
              await session.execute({
                ...entry,
                clientName: "Vehicle viewer",
                action: "unsubscribe",
              });
              await session.execute({ ...entry, clientName: "Vehicle viewer" });
            }

            const finalChecks = scenario.timeline.filter(
              (entry) =>
                entry.kind === "client-view-check" &&
                entry.simulationTime ===
                  Math.max(
                    ...scenario.timeline.map((item) => item.simulationTime),
                  ),
            );

            for (const entry of finalChecks)
              await session.execute({ ...entry, clientName: "Vehicle viewer" });

            assert.equal(
              await browser.page.locator("#history li").count(),
              variant === "basic" ? 2 : 20,
            );
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
}
