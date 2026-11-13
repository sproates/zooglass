export type Key = readonly [number, number, number, number];
type Entry = { key: Key; id?: number; run: () => Promise<void> };

/** Fixed proof scheduler: future work starts at round zero; same-time causes advance a round. */
export class Agenda {
  current: Key = [0, -1, 0, -1];
  private ordinal = 0;
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
      at > 3_600_100 ||
      ![0, 1, 2].includes(phase)
    ) {
      throw new Error("Invalid agenda coordinate");
    }
    const round = root || at > this.current[0] ? 0 : this.current[1] + 1;
    if (round > 100 || this.entries.length >= 1000) {
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
    while (this.entries.length && this.entries[0].key[0] <= at) {
      const entry = this.entries.shift()!;
      if (++this.turns > 2000) {
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
