import type { Scenario } from "../scenario/scenario.js";

export type CompatibilityIssue = { path: string; reason: string };
/** Conservative migration assessment, not a converter or runtime qualification. */
export function assessLegacyScenario(scenario: Scenario) {
  const issues: CompatibilityIssue[] = [];
  const kinds: Record<string, number> = {};
  const add = (path: string, reason: string) => issues.push({ path, reason });
  for (const [index, client] of scenario.clients.entries()) {
    if (
      client.initialState === "connecting" ||
      client.initialState === "disconnecting"
    ) {
      add(
        `clients[${index}].initialState`,
        "transient client state needs explicit connection completion semantics",
      );
    }
  }
  for (const [index, entry] of scenario.timeline.entries()) {
    const path = `timeline[${index}]`;
    kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
    if (entry.kind === "data-connection-fault")
      add(
        path,
        "browser data-route fault has no qualified modelled-link equivalent",
      );
    if (entry.kind === "view-definition")
      add(path, "runtime view registration is absent from the controlled host");
    if (entry.kind === "client-state")
      add(
        path,
        "client connection/reconnect and retained-subscription semantics need an explicit actor model",
      );
    if (entry.kind === "view-check")
      add(
        path,
        "HTTP snapshot assertion needs a recorded read after settlement; no controlled read adapter yet",
      );
    if (entry.kind === "client-view-check")
      add(
        path,
        "legacy expected-value wait must become a settled-time observation with explicit envelope/frame expectations",
      );
    if (entry.kind === "source-event" && entry.expectedRejection)
      add(
        path,
        "expected rejection must be an explicit receipt assertion, not an implicit send-side wait",
      );
    const siblings = scenario.timeline.filter(
      (other) => other.simulationTime === entry.simulationTime,
    );
    if (
      entry.kind === "source-event" &&
      siblings.filter((other) => other.kind === "source-event").length > 1
    ) {
      add(
        path,
        "same-time publications become a burst before derived writer turns; delivery/coalescing can differ",
      );
    }
    if (
      (entry.kind === "view-check" || entry.kind === "client-view-check") &&
      scenario.timeline
        .slice(index + 1)
        .some(
          (other) =>
            other.simulationTime === entry.simulationTime &&
            !["view-check", "client-view-check"].includes(other.kind),
        )
    ) {
      add(
        path,
        "check precedes a later same-time action; moving it to settlement changes the observation point",
      );
    }
    if (
      entry.kind === "client-state" &&
      scenario.timeline
        .slice(0, index)
        .some(
          (other) =>
            other.simulationTime === entry.simulationTime &&
            ["source-event", "client-subscription"].includes(other.kind),
        )
    ) {
      add(
        path,
        "phase-zero lifecycle precedes same-time inputs, unlike legacy declaration order",
      );
    }
  }
  return {
    name: scenario.name,
    unchangedExecutionSupported: false,
    blocker:
      "Legacy scenarios require conversion to timeline-simulation/v1 with explicit connection actions and settled-time assertions.",
    kinds,
    issues,
  };
}
