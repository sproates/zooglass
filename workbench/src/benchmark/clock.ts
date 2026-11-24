import {
  setTimeout as delay,
  setImmediate as yieldTurn,
} from "node:timers/promises";

export interface ClockHost {
  now(): number;
  delay(ms: number, signal?: AbortSignal): Promise<void>;
  yield(signal?: AbortSignal): Promise<void>;
}

const nodeHost: ClockHost = {
  now: () => performance.now(),
  delay: (ms, signal) => delay(ms, undefined, { signal }),
  yield: (signal) => yieldTurn(undefined, { signal }),
};

/** Wall-clock pacing shared by service runs and their client-only control. */
export function benchmarkClock(signal?: AbortSignal, host = nodeHost) {
  return {
    now: () => host.now(),
    async sleep(ms: number) {
      signal?.throwIfAborted();
      const deadline = host.now() + Math.max(0, ms);
      // Even overdue work yields so socket callbacks and cancellation can run.
      // Keep fine-grained polls inside this wait, outside diagnostic wake records.
      do {
        const remaining = deadline - host.now();
        if (remaining >= 2) await host.delay(Math.floor(remaining) - 1, signal);
        else await host.yield(signal);
        signal?.throwIfAborted();
      } while (host.now() < deadline);
    },
  };
}
