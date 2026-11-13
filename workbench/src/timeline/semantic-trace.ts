import type { Key } from "./agenda.js";
import { encodeJson, parseJson, type Json } from "./json.js";

export const metadataJson = (value: unknown): Json =>
  parseJson(JSON.stringify(value));
export type Outcome =
  "passed" | "assertion-failed" | "limit-exceeded" | "infrastructure-failed";
export type Counts = {
  pendingFutureTasks: number;
  pendingMessages: number;
  heldFrames: number;
};

/** Append while executing. IDs are allocated here, never reconstructed from a saved transcript. */
export class SemanticTrace {
  private lines: string[] = [];
  private bytes = 0;
  private events = 0;
  constructor(
    header: unknown,
    private readonly limit: number,
    private readonly observe?: (line: string) => void,
  ) {
    this.append(metadataJson(header));
  }
  private append(value: Json, terminal = false) {
    const line = encodeJson(value) + "\n";
    if (
      this.bytes + Buffer.byteLength(line) >
      this.limit - (terminal ? 0 : 512)
    )
      throw new Error("limit-exceeded: trace bytes");
    // Validate the wrapped representation before it can enter the retained prefix.
    parseJson(line);
    this.bytes += Buffer.byteLength(line);
    this.lines.push(line);
    this.observe?.(line);
  }
  event(
    kind: string,
    key: Key,
    actor: string,
    connectionGeneration: number | null,
    parent: string | null,
    data: Json,
    causes: string[] = [],
    runtimeGeneration: number | null = 1,
  ) {
    const id = `event-${this.events}`;
    if (this.events >= 99998) throw new Error("limit-exceeded: trace records");
    this.append({
      ...(metadataJson({
        kind,
        eventId: id,
        parentId: parent,
        key,
        actor,
        runtimeGeneration,
        connectionGeneration,
        ...(causes.length ? { causes } : {}),
      }) as { [key: string]: Json }),
      data,
    });
    this.events++;
    return id;
  }
  finish(outcome: Exclude<Outcome, "infrastructure-failed">, counts: Counts) {
    this.append(
      metadataJson({
        kind: "result",
        outcome,
        eventCount: this.events,
        ...counts,
      }),
      true,
    );
    return this.prefix();
  }
  prefix() {
    return this.lines.join("");
  }
}
