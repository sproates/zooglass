import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";
import type { TraceEntry } from "../playback.js";
import type { ScenarioSession } from "../scenario-session.js";

interface RenderedVehicleState {
  sequence: string | null;
  coordinates: string | null;
  marker: (string | null)[];
  markerVisible: boolean;
  sequenceVisible: boolean;
  coordinatesVisible: boolean;
  rows: (string | null)[];
  historyVisible: boolean;
  rowsVisible: boolean;
  routeVisible: boolean;
  route: string;
  latestState?: string;
  historyState?: string;
}

type Position = { sequence: number; latitude: number; longitude: number };

/** Read the rendered page independently. Expectations never enter the app. */
export function observeVehicleSession(
  session: ScenarioSession,
  page: Page,
  signal: AbortSignal,
) {
  let latest: Position | undefined;
  let history: Position[] | undefined;

  const coordinates = (p: Position) =>
    `${p.latitude.toFixed(3)}, ${p.longitude.toFixed(3)}`;

  // Deliberately independent of the app's projection implementation.
  const point = (p: Position) => [
    60 + (p.longitude + 0.35) * 1200,
    270 - (p.latitude - 50.95) * 550,
  ];

  const check = async (entry: TraceEntry) => {
    const deadline = AbortSignal.timeout(5_000);
    const combined = AbortSignal.any([signal, deadline]);
    let last = "No rendered observation.";

    try {
      while (true) {
        combined.throwIfAborted();

        // Even an unresponsive renderer cannot keep a cancelled step pending.
        let onAbort!: () => void;
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(combined.reason);
          combined.addEventListener("abort", onAbort, { once: true });

          if (combined.aborted) onAbort();
        });
        let actual;

        try {
          actual = await Promise.race([
            page.evaluate<RenderedVehicleState>(`(() => {
              const element = (id) => document.getElementById(id);
              const visible = (id) => {
                const node = element(id);
                const style = getComputedStyle(node);
                const box = node.getBoundingClientRect();
                return (
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  Number(style.opacity) > 0 &&
                  box.width > 0 &&
                  box.height > 0
                );
              };
              return {
                sequence: element("current-sequence").textContent,
                coordinates: element("current-coordinates").textContent,
                marker: [
                  element("vehicle-marker").getAttribute("cx"),
                  element("vehicle-marker").getAttribute("cy"),
                ],
                markerVisible: visible("vehicle-marker"),
                sequenceVisible: visible("current-sequence"),
                coordinatesVisible: visible("current-coordinates"),
                rows: Array.from(
                  element("history").children,
                  (row) => row.textContent,
                ),
                historyVisible: visible("history-panel"),
                rowsVisible: Array.from(element("history").children).every(row => {
                  const style = getComputedStyle(row);
                  return style.display !== "none" && style.visibility !== "hidden" &&
                    Number(style.opacity) > 0 && row.getBoundingClientRect().height > 0;
                }),
                routeVisible: getComputedStyle(element("route-line")).display !== "none" &&
                  getComputedStyle(element("route-line")).visibility !== "hidden" &&
                  Number(getComputedStyle(element("route-line")).opacity) > 0,
                route: element("route-line").getAttribute("points") ?? "",
                latestState: element("latest-status").dataset.state,
                historyState: element("history-status").dataset.state,
              };
            })()`),
            aborted,
          ]);
        } finally {
          combined.removeEventListener("abort", onAbort);
        }

        try {
          if (latest) {
            assert.equal(
              actual.sequence,
              String(latest.sequence),
              "current sequence",
            );
            assert.equal(
              actual.coordinates,
              coordinates(latest),
              "current coordinates",
            );
            assert.ok(
              actual.sequenceVisible &&
                actual.coordinatesVisible &&
                actual.markerVisible,
              "current position must be visible",
            );
            assert.equal(
              actual.latestState,
              "received",
              "latest view freshness",
            );
            point(latest).forEach((value, index) => {
              assert.ok(
                actual.marker[index] !== null &&
                  Math.abs(Number(actual.marker[index]) - value) < 0.001,
                `marker coordinate ${index}`,
              );
            });
          }

          if (history) {
            assert.ok(actual.historyVisible, "history panel must be visible");
            assert.ok(
              actual.rowsVisible && actual.routeVisible,
              "history rows and route must be visible",
            );
            assert.equal(actual.historyState, "received", "history freshness");
            assert.deepEqual(
              actual.rows,
              history.map((p) => `Position ${p.sequence} · ${coordinates(p)}`),
              "history rows and order",
            );

            const points = actual.route.trim()
              ? actual.route
                  .trim()
                  .split(/\s+/)
                  .map((pair) => pair.split(",").map(Number))
              : [];

            assert.equal(points.length, history.length, "route point count");
            history.forEach((p, index) =>
              point(p).forEach((value, axis) =>
                assert.ok(
                  Math.abs(points[index][axis] - value) < 0.001,
                  `route point ${index}, coordinate ${axis}`,
                ),
              ),
            );
          }

          signal.throwIfAborted();

          return;
        } catch (error) {
          last = error instanceof Error ? error.message : String(error);
        }

        await delay(25, undefined, { signal: combined });
      }
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(
        `Rendered check failed at +${entry.simulationTime}ms (${entry.kind}): ${last} ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };

  return {
    async execute(entry: TraceEntry) {
      await session.execute(entry);

      if (
        entry.kind === "view-check" &&
        entry.entityId === "car-17" &&
        entry.expected
      ) {
        if (entry.viewId === "live-map")
          latest = entry.expected.position as Position;

        if (entry.viewId === "trip-history")
          history = entry.expected.positions as Position[];
      }

      if (entry.kind === "client-view-check" && entry.entityId === "car-17") {
        if (entry.viewId === "live-map")
          latest = entry.expected.position as Position;

        if (entry.viewId === "trip-history")
          history = entry.expected.positions as Position[];

        await check(entry);
      }
    },
    close: session.close,
  };
}
