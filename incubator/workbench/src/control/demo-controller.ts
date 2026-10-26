import { setTimeout as delay } from "node:timers/promises";
import { playScenario, type TraceEntry } from "../scenario/playback.js";
import type { Scenario } from "../scenario/scenario.js";
import { planDemoSteps } from "./demo-steps.js";

export type DemoState = {
  phase:
    | "starting"
    | "ready"
    | "intervening"
    | "stepping"
    | "complete"
    | "failed"
    | "resetting"
    | "closed";
  exploratory: boolean;
  interventions: number;
  lastIntervention: string;
  skippedChecks: number;
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
  const { setup, steps } = planDemoSteps(playScenario(scenario));
  const total = steps.length;
  let state: DemoState = {
    phase: "starting",
    exploratory: false,
    interventions: 0,
    lastIntervention: "",
    skippedChecks: 0,
    playing: false,
    completed: 0,
    total,
    detail: "Starting a fresh session…",
  };
  let run: DemoRun | undefined;
  let controller = new AbortController();
  let cursor = 0;
  let interventionTask: Promise<void> | undefined;
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
    state = {
      ...state,
      phase,
      detail: state.exploratory ? `Exploratory run · ${detail}` : detail,
    };
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
      await interventionTask?.catch(() => {});
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

      state = {
        ...state,
        completed: 0,
        exploratory: false,
        interventions: 0,
        lastIntervention: "",
        skippedChecks: 0,
      };
      cursor = 0;
      remaining = steps[0].delayBefore;
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
      for (const entry of setup) await run.execute(entry);
      current.signal.throwIfAborted();
      update(
        "ready",
        "Ready. Step runs the next action and awaits its checks.",
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
      interventionTask ||
      (!automatic && playbackTask) ||
      state.phase !== "ready" ||
      !run
    )
      return Promise.reject(new Error("Step requires a ready, idle run."));

    const current = controller;
    const activeRun = run;

    update("stepping", `Running step ${state.completed + 1} of ${total}…`);
    stepTask = (async () => {
      for (const entry of steps[cursor].entries) {
        current.signal.throwIfAborted();

        if (state.exploratory && entry.kind === "client-view-check") {
          state = { ...state, skippedChecks: state.skippedChecks + 1 };
          continue;
        }

        await activeRun.execute(entry);
      }
      current.signal.throwIfAborted();
      activeRun.signal.throwIfAborted();
      cursor++;
      remaining = steps[cursor]?.delayBefore ?? 0;
      state = { ...state, completed: state.completed + 1 };

      if (cursor === steps.length) stopPlayback();

      update(
        cursor === steps.length ? "complete" : "ready",
        cursor === steps.length
          ? state.exploratory
            ? "Finished for inspection; not a scripted pass. Reset to verify again."
            : "All steps checked. Reset to run again."
          : "Step finished. Ready for the next action.",
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
    intervene(label: string, entries: TraceEntry[]): Promise<void> {
      if (
        closing ||
        resetTask ||
        stepTask ||
        playbackTask ||
        interventionTask ||
        !run ||
        !["ready", "complete"].includes(state.phase)
      )
        return Promise.reject(
          new Error("Viewer controls require a paused, idle run."),
        );

      const phase = state.phase;
      const current = controller;
      const activeRun = run;

      state = {
        ...state,
        exploratory: true,
        interventions: state.interventions + 1,
        lastIntervention: label,
      };
      update("intervening", `${label}…`);
      interventionTask = (async () => {
        for (const entry of entries) {
          current.signal.throwIfAborted();
          await activeRun.execute(entry);
        }
        current.signal.throwIfAborted();
        activeRun.signal.throwIfAborted();
        update(
          phase,
          `${label} completed. Client checks are skipped until Reset; this is not a scripted pass.`,
        );
      })()
        .catch((error) => {
          if (!current.signal.aborted)
            update(
              "failed",
              `${label} failed: ${reason(error)}. Reset to try again.`,
            );

          throw error;
        })
        .finally(() => {
          interventionTask = undefined;
        });

      return interventionTask;
    },
    play(): Promise<void> {
      if (
        closing ||
        resetTask ||
        stepTask ||
        interventionTask ||
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
        await interventionTask?.catch(() => {});
        await stepTask?.catch(() => {});
        await run?.close();
        update("closed", "Demo closed.");
      })();

      return closing;
    },
  };
}
