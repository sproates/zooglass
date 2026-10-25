import type { TraceEntry } from "./playback.js";

export interface DemoStep {
  entries: TraceEntry[];
  /** Gap from the preceding checkpoint's final entry, not its opening action. */
  delayBefore: number;
}

/** Group an ordered trace without owning a cursor, timer or run resources. */
export function planDemoSteps(trace: TraceEntry[]) {
  const first = trace.findIndex((entry) => entry.kind === "source-event");
  if (first < 0) throw new Error("The demo needs at least one source event.");
  const steps: DemoStep[] = [];
  let start = first;
  while (start < trace.length) {
    let end = start + 1;
    while (
      end < trace.length &&
      trace[end].kind !== "source-event" &&
      trace[end].kind !== "client-state"
    )
      end++;
    steps.push({
      entries: trace.slice(start, end),
      delayBefore: Math.max(
        0,
        trace[start].simulationTime - (trace[start - 1]?.simulationTime ?? 0),
      ),
    });
    start = end;
  }
  return { setup: trace.slice(0, first), steps };
}
