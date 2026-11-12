import { createPlaybackController, type DemoRun } from "./demo-controller.js";

export interface PreparedCheckpoint<Run> {
  id: string;
  label: string;
  execute(run: Run, signal: AbortSignal): Promise<void>;
}

/** Domain checks plug into the existing Step/Play/Pause/Reset lifecycle. */
export function createCheckpointController<
  Run extends Omit<DemoRun, "execute">,
>(
  checkpoints: PreparedCheckpoint<Run>[],
  openRun: (signal: AbortSignal) => Promise<Run>,
  delayBefore = 1000,
) {
  return createPlaybackController(
    {
      setup: [],
      steps: checkpoints.map((checkpoint) => ({
        entries: [checkpoint],
        delayBefore,
      })),
    },
    async (signal) => {
      const run = await openRun(signal);
      return {
        signal: run.signal,
        close: () => run.close(),
        publish: (state) => run.publish(state),
        execute: (checkpoint) => checkpoint.execute(run, signal),
      };
    },
  );
}
