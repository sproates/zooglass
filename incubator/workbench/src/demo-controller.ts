import { setTimeout as delay } from "node:timers/promises";
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
  playing: boolean;
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
    playing: false,
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
  let playbackTask: Promise<void> | undefined;
  let timer: AbortController | undefined;
  let remaining = 0;
  const stopPlayback = () => {
    state = { ...state, playing: false };
    timer?.abort();
  };
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
    stopPlayback();
    update("resetting", "Resetting: stopping the old session…");
    controller.abort(new Error("Run replaced by reset."));
    resetTask = (async () => {
      await playbackTask;
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
      remaining = Math.max(
        0,
        trace[first].simulationTime - (trace[first - 1]?.simulationTime ?? 0),
      );
      run = await openRun(current.signal);
      current.signal.throwIfAborted();
      const failed = () => {
        if (controller !== current || current.signal.aborted) return;
        stopPlayback();
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
  const step = (automatic = false): Promise<void> => {
    if (
      closing ||
      resetTask ||
      stepTask ||
      (!automatic && playbackTask) ||
      state.phase !== "ready" ||
      !run
    )
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
      remaining =
        end < trace.length
          ? Math.max(
              0,
              trace[end].simulationTime - trace[end - 1].simulationTime,
            )
          : 0;
      cursor = end;
      state = { ...state, completed: state.completed + 1 };
      if (cursor === trace.length) stopPlayback();
      update(
        cursor === trace.length ? "complete" : "ready",
        cursor === trace.length
          ? "All steps checked. Reset to run again."
          : "Step checked. Ready for the next position.",
      );
    })()
      .catch((error) => {
        stopPlayback();
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
  };
  return {
    get state() {
      return { ...state };
    },
    reset,
    step: () => step(),
    play(): Promise<void> {
      if (
        closing ||
        resetTask ||
        stepTask ||
        playbackTask ||
        state.phase !== "ready" ||
        !run
      )
        return Promise.reject(new Error("Play requires a ready, idle run."));
      const current = controller;
      const activeRun = run;
      state = { ...state, playing: true };
      update(
        "ready",
        "Playing. Pause stops future actions; current checks finish.",
      );
      playbackTask = (async () => {
        while (state.playing && state.phase === "ready") {
          timer = new AbortController();
          const started = performance.now();
          try {
            await delay(remaining, undefined, {
              signal: AbortSignal.any([
                timer.signal,
                current.signal,
                activeRun.signal,
              ]),
            });
          } catch (error) {
            current.signal.throwIfAborted();
            activeRun.signal.throwIfAborted();
            if (!timer.signal.aborted) throw error;
          } finally {
            remaining = Math.max(0, remaining - (performance.now() - started));
            timer = undefined;
          }
          current.signal.throwIfAborted();
          activeRun.signal.throwIfAborted();
          if (!state.playing) break;
          await step(true);
        }
      })()
        .catch((error) => {
          stopPlayback();
          if (!current.signal.aborted && state.phase !== "failed")
            update(
              "failed",
              `Playback failed: ${reason(error)}. Reset to try again.`,
            );
        })
        .finally(() => {
          playbackTask = undefined;
          if (!current.signal.aborted && state.phase === "ready")
            update(
              "ready",
              "Paused. Step advances once; Play resumes the remaining delay.",
            );
        });
      return Promise.resolve();
    },
    async pause(): Promise<void> {
      if (!state.playing || !playbackTask)
        throw new Error("Pause requires active playback.");
      stopPlayback();
      update(
        state.phase,
        "Pausing. Any in-flight action and checks will finish.",
      );
      await playbackTask;
    },
    close(): Promise<void> {
      if (closing) return closing;
      stopPlayback();
      controller.abort(new Error("Demo closed."));
      closing = (async () => {
        await resetTask?.catch(() => {});
        await playbackTask;
        await stepTask?.catch(() => {});
        await run?.close();
        update("closed", "Demo closed.");
      })();
      return closing;
    },
  };
}
