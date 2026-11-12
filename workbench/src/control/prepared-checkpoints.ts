import {
  createPlaybackController,
  type DemoRun,
  type DemoState,
} from "./demo-controller.js";

export interface PreparedCheckpoint<Run> {
  id: string;
  label: string;
  execute(run: Run, signal: AbortSignal): Promise<void>;
}

/** Domain checks plug into the existing Step/Play/Pause/Reset lifecycle. */
export function createCheckpointController<
  Run extends Omit<DemoRun, "execute" | "publish">,
>(
  checkpoints: PreparedCheckpoint<Run>[],
  openRun: (signal: AbortSignal) => Promise<Run>,
  publish: (state: DemoState) => void,
  delayBefore = 1000,
) {
  return createPlaybackController(
    {
      setup: [],
      publish,
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
        publish,
        execute: (checkpoint) => checkpoint.execute(run, signal),
      };
    },
  );
}
