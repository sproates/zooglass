import { planDemoSteps } from "../../control/demo-steps.js";
import { playScenario } from "../../scenario/playback.js";
import type { Scenario } from "../../scenario/scenario.js";
import type { DemoState } from "../../control/demo-controller.js";

/** Describe planned actions, never inferred outcomes or received state. */
export function vehicleStepDescriptions(scenario: Scenario): string[] {
  const { steps } = planDemoSteps(playScenario(scenario));
  const domains = new Map<string, { sent: Set<number>; highest: number }>();

  return steps.map(({ entries }) => {
    const action = entries[0];

    if (action.kind === "data-connection-fault")
      return action.action === "break"
        ? "Interrupt the viewer data route and wait for a refused automatic retry."
        : "Restore the route and wait for automatic recovery with fresh snapshots.";

    if (action.kind === "client-state")
      return action.state === "connected"
        ? `Reconnect ${action.clientName} and resubscribe to the views.`
        : `Disconnect ${action.clientName}; the source can continue sending.`;

    if (action.kind !== "source-event")
      return "Execute the next scenario action.";

    const sequence = action.payload.sequence;

    if (typeof sequence !== "number" || !Number.isFinite(sequence))
      return `Send ${action.type} from ${action.sourceName}.`;

    const key = JSON.stringify([action.sourceId, action.type, action.entityId]);
    const domain = domains.get(key) ?? {
      sent: new Set<number>(),
      highest: -Infinity,
    };
    domains.set(key, domain);
    const qualifier = domain.sent.has(sequence)
      ? "duplicate "
      : sequence < domain.highest
        ? "late "
        : "";

    domain.sent.add(sequence);
    domain.highest = Math.max(domain.highest, sequence);

    const kind =
      action.type === "vehicle.operation.updated" ? "operation" : "position";
    return `Send ${qualifier}${kind} ${sequence} from ${action.sourceName} for ${action.entityId}.`;
  });
}

export function describeVehicleProgress(
  state: DemoState,
  steps: string[],
): string {
  if (state.phase === "intervening")
    return `Current action: ${state.lastIntervention}.`;
  if (state.phase === "complete")
    return "No further scripted steps. Reset to start again.";
  if (state.phase === "failed") return "Run stopped. Reset before continuing.";
  if (state.phase === "closed") return "Run closed.";
  if (state.phase === "starting" || state.phase === "resetting")
    return "Preparing a fresh run.";

  const label =
    state.phase === "stepping" ? "Current step" : "Next scripted step";
  const checks = state.exploratory
    ? "Browser receipt checks are skipped in exploratory mode."
    : "The step also waits for its scripted checks.";

  return `${label}: ${steps[state.completed]} ${checks}`;
}
