import { playScenario, type TraceEntry } from "./playback.js";
import type { Scenario } from "./scenario.js";

export type DemoState = {
  phase:
    | "starting"
    | "ready"
    | "stepping"
    | "complete"
    | "failed"
    | "resetting"
    | "closed";
  completed: number;
  total: number;
  detail: string;
};
export class DemoCleanupError extends Error {}

export interface DemoRun {
  signal: AbortSignal;
  execute(entry: TraceEntry): Promise<void>;
  close(): Promise<void>;
  publish(state: DemoState): void;
}

/** One scenario cursor, with cancellable replacement of its owned run. */
export function createDemoController(
  scenario: Scenario,
  openRun: (signal: AbortSignal) => Promise<DemoRun>,
) {
  const trace = playScenario(scenario);
  const first = trace.findIndex((entry) => entry.kind === "source-event");
  if (first < 0) throw new Error("The demo needs at least one source event.");
  const total = trace.filter((entry) => entry.kind === "source-event").length;
  let state: DemoState = {
    phase: "starting",
    completed: 0,
    total,
    detail: "Starting a fresh session…",
  };
  let run: DemoRun | undefined;
  let controller = new AbortController();
  let cursor = first;
  let stepTask: Promise<void> | undefined;
  let resetTask: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let cleanupFailed = false;
  const update = (phase: DemoState["phase"], detail: string) => {
    state = { ...state, phase, detail };
    run?.publish(state);
  };
  const reason = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  const reset = (): Promise<void> => {
    if (closing) return Promise.reject(new Error("Demo is closed."));
    if (resetTask)
      return Promise.reject(new Error("Reset is already running."));
    if (cleanupFailed)
      return Promise.reject(
        new Error("Cleanup failed. Stop the demo before trying again."),
      );
    update("resetting", "Resetting: stopping the old session…");
    controller.abort(new Error("Run replaced by reset."));
    resetTask = (async () => {
      await stepTask?.catch(() => {});
      if (run) {
        try {
          await run.close();
        } catch (error) {
          cleanupFailed = true;
          throw error;
        }
        run = undefined;
      }
      if (closing) return;
      controller = new AbortController();
      const current = controller;
      state = { ...state, completed: 0 };
      cursor = first;
      run = await openRun(current.signal);
      current.signal.throwIfAborted();
      const failed = () => {
        if (controller !== current || current.signal.aborted) return;
        update(
          "failed",
          `Run failed: ${reason(run!.signal.reason)}. Reset to try again.`,
        );
      };
      run.signal.addEventListener("abort", failed, { once: true });
      run.signal.throwIfAborted();
      for (const entry of trace.slice(0, first)) await run.execute(entry);
      current.signal.throwIfAborted();
      update(
        "ready",
        "Ready. Step sends the next position and awaits its checks.",
      );
    })()
      .catch((error) => {
        if (error instanceof DemoCleanupError) cleanupFailed = true;
        if (!closing)
          update(
            "failed",
            `Reset failed: ${reason(error)}. ${cleanupFailed ? "Stop the demo." : "Reset to try again."}`,
          );
        throw error;
      })
      .finally(() => {
        resetTask = undefined;
      });
    return resetTask;
  };
  return {
    get state() {
      return { ...state };
    },
    reset,
    step(): Promise<void> {
      if (closing || resetTask || stepTask || state.phase !== "ready" || !run)
        return Promise.reject(new Error("Step requires a ready, idle run."));
      const current = controller;
      const activeRun = run;
      update("stepping", `Running step ${state.completed + 1} of ${total}…`);
      stepTask = (async () => {
        let end = cursor + 1;
        while (end < trace.length && trace[end].kind !== "source-event") end++;
        for (const entry of trace.slice(cursor, end)) {
          current.signal.throwIfAborted();
          await activeRun.execute(entry);
        }
        current.signal.throwIfAborted();
        activeRun.signal.throwIfAborted();
        cursor = end;
        state = { ...state, completed: state.completed + 1 };
        update(
          cursor === trace.length ? "complete" : "ready",
          cursor === trace.length
            ? "All steps checked. Reset to run again."
            : "Step checked. Ready for the next position.",
        );
      })()
        .catch((error) => {
          if (!current.signal.aborted)
            update(
              "failed",
              `Step failed: ${reason(error)}. Reset to try again.`,
            );
          throw error;
        })
        .finally(() => {
          stepTask = undefined;
        });
      return stepTask;
    },
    close(): Promise<void> {
      if (closing) return closing;
      controller.abort(new Error("Demo closed."));
      closing = (async () => {
        await resetTask?.catch(() => {});
        await stepTask?.catch(() => {});
        await run?.close();
        update("closed", "Demo closed.");
      })();
      return closing;
    },
  };
}
