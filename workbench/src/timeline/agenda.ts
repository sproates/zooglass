export type Key = readonly [number, number, number, number];
type Entry = { key: Key; id?: number; run: () => Promise<void> };

/** Fixed proof scheduler: future work starts at round zero; same-time causes advance a round. */
export class Agenda {
  constructor(
    private readonly limits = { turns: 2000, rounds: 100, queuedEvents: 1000 },
  ) {}
  current: Key = [0, -1, 0, -1];
  private ordinal = 0;
  private nextModelTask = -1;
  allocateModelTask() {
    return this.nextModelTask--;
  }
  private turns = 0;
  private entries: Entry[] = [];
  add(
    at: number,
    phase: number,
    run: () => Promise<void>,
    id?: number,
    root = false,
  ) {
    if (
      !Number.isSafeInteger(at) ||
      at < this.current[0] ||
      at > Number.MAX_SAFE_INTEGER ||
      ![0, 1, 2].includes(phase)
    ) {
      throw new Error("Invalid agenda coordinate");
    }
    const round = root || at > this.current[0] ? 0 : this.current[1] + 1;
    if (
      round > this.limits.rounds ||
      this.entries.length >= this.limits.queuedEvents
    ) {
      throw new Error("limit-exceeded: agenda");
    }
    this.entries.push({ key: [at, round, phase, this.ordinal++], id, run });
    this.entries.sort((a, b) =>
      a.key.reduce((order, item, index) => order || item - b.key[index], 0),
    );
  }
  cancel(id: number) {
    this.entries = this.entries.filter((entry) => entry.id !== id);
  }
  async through(at: number) {
    if (!Number.isSafeInteger(at) || at < this.current[0])
      throw new Error("Invalid settlement time");
    while (this.entries.length && this.entries[0].key[0] <= at) {
      const entry = this.entries.shift()!;
      if (++this.turns > this.limits.turns) {
        throw new Error("limit-exceeded: turns");
      }
      this.current = entry.key;
      await entry.run();
    }
    this.current = [
      at,
      this.current[0] === at ? this.current[1] + 1 : 0,
      2,
      this.ordinal++,
    ];
  }
  pending() {
    return this.entries.map(({ key, id }) => ({ key, id }));
  }
}
