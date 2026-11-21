/** Global open-loop slots. A late wake never releases a catch-up burst. */
export class Schedule {
  readonly total: number;
  private next = 0;
  constructor(
    readonly rate: number,
    readonly durationMs: number,
  ) {
    if (
      !Number.isFinite(rate) ||
      rate <= 0 ||
      rate > 1000 ||
      !Number.isSafeInteger(durationMs) ||
      durationMs < 1 ||
      durationMs > 120000
    )
      throw new Error("Invalid benchmark rate or duration");
    this.total = Math.ceil((rate * durationMs) / 1000);
  }
  get remaining() {
    return this.total - this.next;
  }
  get nextMs() {
    return (this.next * 1000) / this.rate;
  }
  wake(elapsedMs: number): {
    slot?: number;
    plannedMs?: number;
    missed: number;
  } {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0)
      throw new Error("Invalid schedule clock");
    if (!this.remaining || elapsedMs < this.nextMs) return { missed: 0 };
    let latest = Math.min(
      this.total - 1,
      Math.max(this.next, Math.floor((elapsedMs * this.rate) / 1000)),
    );
    // Rounded division and its inverse can differ by one at a fractional slot.
    if (latest > this.next && (latest * 1000) / this.rate > elapsedMs) {
      latest--;
    } else if (
      latest + 1 < this.total &&
      ((latest + 1) * 1000) / this.rate <= elapsedMs
    ) {
      latest++;
    }
    const plannedMs = (latest * 1000) / this.rate;
    const missed = latest - this.next;
    this.next = latest + 1;
    if (elapsedMs >= this.durationMs || elapsedMs - plannedMs > 10)
      return { missed: missed + 1 };
    return { slot: latest, plannedMs, missed };
  }
}

export function scheduleWindows(warmup: Schedule, measurement: Schedule) {
  return (
    [
      ["warmup", warmup],
      ["measurement", measurement],
    ] as const
  ).map(([phase, schedule]) => ({
    phase,
    startMs: null as number | null,
    endMs: null as number | null,
    planned: schedule.total,
    missed: 0,
    notOffered: schedule.total,
  }));
}

/** Pin both windows to one epoch, including when a wake crosses their boundary. */
export async function driveWindows(
  schedules: readonly [Schedule, Schedule],
  windows: ReturnType<typeof scheduleWindows>,
  startMs: number,
  clock: { now(): number; sleep(ms: number): Promise<void> },
  check: () => void,
  offer: (
    phase: "warmup" | "measurement",
    slot: number,
    plannedMs: number,
  ) => void,
) {
  let nextStart = startMs;
  for (const [i, window] of windows.entries()) {
    window.startMs = nextStart;
    nextStart += schedules[i].durationMs;
    window.endMs = nextStart;
  }
  for (const [i, schedule] of schedules.entries()) {
    const window = windows[i];
    const origin = window.startMs!;
    while (schedule.remaining || clock.now() < window.endMs!) {
      check();
      const step = schedule.wake(clock.now() - origin);
      window.missed += step.missed;
      if (step.slot !== undefined) {
        offer(window.phase, step.slot, origin + step.plannedMs!);
        window.notOffered--;
      }
      const next = schedule.remaining
        ? origin + schedule.nextMs
        : window.endMs!;
      const sleepMs = next - clock.now();
      if (sleepMs > 0 || (schedule.remaining && clock.now() < window.endMs!)) {
        await clock.sleep(Math.max(0, sleepMs));
      }
    }
  }
}
