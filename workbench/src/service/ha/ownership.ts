import {
  IncarnationChanged,
  runtimeIncarnation,
  type Envelope,
} from "./protocol.js";

/** Share one instance between the viewer and producer for one logical deployment. */
export class Ownership {
  private pin?: string;
  private highest = 0n;
  private readonly invalidation = new AbortController();
  private readonly observers = new Set<() => void>();
  constructor(incarnation?: string) {
    this.pin =
      incarnation === undefined ? undefined : runtimeIncarnation(incarnation);
  }
  get incarnation(): string | undefined {
    return this.pin;
  }
  get generation(): bigint {
    return this.highest;
  }
  get signal(): AbortSignal {
    return this.invalidation.signal;
  }
  assertAvailable(): void {
    if (this.signal.aborted) throw this.signal.reason;
  }
  rejectIncarnation(): never {
    if (!this.signal.aborted) {
      const failure = new IncarnationChanged(
        "Runtime incarnation changed; explicit reconciliation is required",
      );
      this.invalidation.abort(failure);
      this.notify();
    }
    throw this.signal.reason;
  }
  listen(observer: () => void): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }
  private notify(): void {
    // A presentation callback must not prevent other roles from retiring their transports.
    for (const observer of this.observers) {
      try {
        observer();
      } catch {
        /* Ownership changes are already committed locally. */
      }
    }
  }
  observe(frame: Envelope): boolean {
    this.assertAvailable();
    if (this.pin !== undefined && frame.incarnation !== this.pin) {
      this.rejectIncarnation();
    }
    if (frame.generation < this.highest) {
      return false;
    }
    this.pin = frame.incarnation;
    if (frame.generation > this.highest) {
      this.highest = frame.generation;
      this.notify();
    }
    return true;
  }
}
