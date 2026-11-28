import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  AccessFailure,
  IncarnationChanged,
  ProtocolFailure,
} from "./protocol.js";

export interface RecoveryBounds {
  stepMillis?: number;
  episodeMillis?: number;
}
export class Episode {
  readonly end: number;
  readonly stepMillis: number;
  constructor(bounds: RecoveryBounds = {}) {
    this.stepMillis = bounds.stepMillis ?? 5000;
    const total = bounds.episodeMillis ?? 30000;
    if (
      !Number.isInteger(this.stepMillis) ||
      this.stepMillis < 1 ||
      this.stepMillis > 5000 ||
      !Number.isInteger(total) ||
      total < 1 ||
      total > 30000
    ) {
      throw new Error(
        "Recovery bounds may narrow the 5s step and 30s episode limits",
      );
    }
    this.end = performance.now() + total;
  }
  remaining(): number {
    return Math.max(0, Math.ceil(this.end - performance.now()));
  }
  signal(parent: AbortSignal): AbortSignal {
    const remaining = this.remaining();
    if (remaining === 0) {
      throw new Error("Recovery deadline exhausted");
    }
    return AbortSignal.any([
      parent,
      AbortSignal.timeout(Math.min(remaining, this.stepMillis)),
    ]);
  }
  async backoff(attempt: number, parent: AbortSignal): Promise<void> {
    const remaining = this.remaining();
    if (!remaining) {
      throw new Error("Recovery deadline exhausted");
    }
    await delay(
      Math.min(remaining, [250, 500, 1000, 2000][Math.min(attempt, 3)]),
      undefined,
      { signal: parent },
    );
  }
}
export function terminal(error: unknown): boolean {
  return (
    error instanceof AccessFailure ||
    error instanceof ProtocolFailure ||
    error instanceof IncarnationChanged
  );
}
