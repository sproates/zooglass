import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Agenda, type Key } from "./agenda.js";
import { Bridge, type Effect, type Response } from "./bridge.js";
export type TraceEntry = {
  key: Key;
  operation: Record<string, unknown>;
  effects: Effect[];
};
// Only safe receipt/state metadata is inspected; arbitrary payload bytes stay in the wire string.
export type Metadata = {
  type?: string;
  version?: number;
  status?:
    | string
    | {
        fields: {
          position: { freshness: string; receivedAtMillis: number | null };
        };
      };
  reason?: string;
  publicationSequence?: number;
};
export function metadata(wire: string): Metadata {
  return JSON.parse(wire) as Metadata;
}
export function freshness(wire: string) {
  const status = metadata(wire).status;
  assert.equal(typeof status, "object");
  return (status as Exclude<Metadata["status"], string | undefined>).fields
    .position;
}
export class Execution {
  readonly agenda = new Agenda();
  readonly trace: TraceEntry[] = [];
  readonly states: string[] = [];
  readonly clients = new Map<string, string[]>();
  readonly receipts: string[] = [];
  last?: Response;
  receiptArrival: (
    effect: Extract<Effect, { kind: "receipt" }>,
  ) => Promise<void> = async () => {};
  constructor(
    readonly bridge: Bridge,
    readonly disableAlarms = false,
    readonly paced = false,
    readonly replay?: readonly TraceEntry[],
  ) {}
  record(operation: Record<string, unknown>, effects: Effect[] = []) {
    this.trace.push({ key: this.agenda.current, operation, effects });
    if (this.replay) {
      const index = this.trace.length - 1;
      assert.deepEqual(
        this.trace[index],
        this.replay[index],
        `first divergence at turn ${index}`,
      );
    }
    if (Buffer.byteLength(JSON.stringify(this.trace)) > 16 * 1024 * 1024) {
      throw new Error("limit-exceeded: trace");
    }
  }
  async command(operation: Record<string, unknown>) {
    const response = await this.bridge.command(
      this.agenda.current[0],
      operation,
    );
    this.last = response;
    this.record(operation, response.effects);
    for (const effect of response.effects) {
      switch (effect.kind) {
        case "schedule":
          if (!(this.disableAlarms && effect.taskKind === "alarm")) {
            this.agenda.add(
              effect.at,
              effect.phase,
              () => this.command({ op: "task", task: effect.task }),
              effect.task,
            );
          }
          break;
        case "cancel":
          this.agenda.cancel(effect.task);
          break;
        case "state":
          this.states.push(effect.wire);
          break;
        case "receipt":
          this.receipts.push(effect.wire);
          this.agenda.add(this.agenda.current[0], 2, async () => {
            await this.receiptArrival(effect);
          });
          break;
        case "frame":
          this.agenda.add(this.agenda.current[0], 2, async () => {
            this.record({ op: "client-arrival", session: effect.session }, [
              effect,
            ]);
            const frames = this.clients.get(effect.session) ?? [];
            frames.push(effect.wire);
            this.clients.set(effect.session, frames);
          });
          break;
        case "handoff":
        case "close":
          break;
        default:
          throw new Error("Unsupported host effect");
      }
    }
  }
  root(at: number, operation: Record<string, unknown>) {
    const phase = [
      "initialize",
      "connect",
      "disconnect",
      "stall",
      "release",
      "shutdown",
    ].includes(String(operation.op))
      ? 0
      : 2;
    this.agenda.add(at, phase, () => this.command(operation), undefined, true);
  }
  async barrier(at: number) {
    await this.agenda.through(at);
    await this.command({ op: "observe" });
    assert.deepEqual(
      this.last!.effects,
      [],
      "observation must not repair overdue work",
    );
    if (this.paced) {
      await delay(1);
    }
  }
  versions(session: string) {
    return (this.clients.get(session) ?? [])
      .filter((wire) => metadata(wire).type === "view-update")
      .map((wire) => metadata(wire).version);
  }
}
