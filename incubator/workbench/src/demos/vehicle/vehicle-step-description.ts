import { planDemoSteps } from "../../control/demo-steps.js";
import { playScenario } from "../../scenario/playback.js";
import type { Scenario } from "../../scenario/scenario.js";
import type { DemoState } from "../../control/demo-controller.js";

/** Describe planned actions, never inferred outcomes or received state. */
export function vehicleStepDescriptions(scenario: Scenario): string[] {
  const { steps } = planDemoSteps(playScenario(scenario));
  const sent = new Set<number>();
  let highest = -Infinity;

  return steps.map(({ entries }) => {
    const action = entries[0];

    if (action.kind === "client-state")
      return action.state === "connected"
        ? `Reconnect ${action.clientName} and resubscribe to the views.`
        : `Disconnect ${action.clientName}; the source can continue sending.`;

    if (action.kind !== "source-event")
      return "Execute the next scenario action.";

    const sequence = action.payload.sequence;

    if (typeof sequence !== "number" || !Number.isFinite(sequence))
      return `Send ${action.type} from ${action.sourceName}.`;

    const qualifier = sent.has(sequence)
      ? "duplicate "
      : sequence < highest
        ? "late "
        : "";

    sent.add(sequence);
    highest = Math.max(highest, sequence);

    return `Send ${qualifier}position ${sequence} from ${action.sourceName}.`;
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
