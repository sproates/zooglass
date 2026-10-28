import type { Page } from "playwright";
import type { ScenarioSession } from "../../execution/scenario-session.js";
import type { TraceEntry } from "../../scenario/playback.js";

interface Position {
  sequence: number;
  latitude: number;
  longitude: number;
}
interface Operation {
  sequence: number;
  status: string;
}

/** Check visible receipts without selecting a vehicle on the user's behalf. */
export function observeFleetSession(
  session: ScenarioSession,
  page: Page,
  signal: AbortSignal,
): ScenarioSession {
  const coordinates = (p: Position) =>
    `${p.latitude.toFixed(4)}, ${p.longitude.toFixed(4)}`;

  return {
    async execute(entry: TraceEntry) {
      await session.execute(entry);
      if (entry.kind !== "client-view-check") return;
      signal.throwIfAborted();

      const position = entry.expected.position as Position | undefined;
      const operation = entry.expected.operation as Operation | undefined;
      const positions = entry.expected.positions as Position[] | undefined;
      const expected = {
        entityId: entry.entityId,
        viewId: entry.viewId,
        position: position
          ? `Position ${position.sequence} · ${coordinates(position)}`
          : "No position received",
        operation: operation
          ? `${operation.status} · sequence ${operation.sequence}`
          : "No operational status received",
        rows: positions?.map(
          (p) => `Position ${p.sequence} · ${coordinates(p)}`,
        ),
      };
      // Expectations stay in this observer, never in application state.
      await page.waitForFunction(
        (wanted) => {
          const row = Array.from(
            document.querySelectorAll("#fleet-list li"),
          ).find(
            (item) =>
              (item as HTMLElement).dataset.entityId === wanted.entityId,
          );
          if (wanted.viewId === "fleet-state") {
            const position = row?.querySelector(".fleet-position") ?? null;
            const operation = row?.querySelector(".fleet-operation") ?? null;
            return (
              [position, operation].every(
                (node) =>
                  node !== null &&
                  node.getBoundingClientRect().height > 0 &&
                  getComputedStyle(node).visibility !== "hidden" &&
                  getComputedStyle(node).display !== "none" &&
                  Number(getComputedStyle(node).opacity) > 0,
              ) &&
              position?.textContent === wanted.position &&
              operation?.textContent === wanted.operation
            );
          }
          // Do not change the user's selection to check an unselected history.
          if (
            document.getElementById("fleet-detail")?.dataset.entityId !==
            wanted.entityId
          )
            return true;
          const panel = document.getElementById("history-panel");
          const rows = Array.from(
            document.getElementById("history")?.children ?? [],
          );
          return (
            rows.length === wanted.rows?.length &&
            [panel, ...rows].every(
              (node) =>
                node !== null &&
                node.getBoundingClientRect().height > 0 &&
                getComputedStyle(node).visibility !== "hidden" &&
                getComputedStyle(node).display !== "none" &&
                Number(getComputedStyle(node).opacity) > 0,
            ) &&
            rows.every(
              (node, index) => node.textContent === wanted.rows?.[index],
            )
          );
        },
        expected,
        { timeout: 5000 },
      );
      signal.throwIfAborted();
    },
    close: session.close,
  };
}
