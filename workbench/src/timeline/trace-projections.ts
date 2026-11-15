import {
  acceptedReceipt,
  type DeliveredReceipt,
} from "./projected-assertions.js";
import type { TraceEvent } from "./trace-generations.js";
import { invalid } from "./validation.js";
import { staticActionKinds } from "./static-contract.js";

/** Binds projected receipt assertions to real arrivals, without consuming full observations. */
export class TraceProjections {
  readonly assertions: TraceEvent[] = [];
  readonly actions: TraceEvent[] = [];
  private readonly receipts: DeliveredReceipt[] = [];
  private readonly used = new Set<string>();
  private readonly sends = new Map<string, TraceEvent>();

  accept(event: TraceEvent, path: string) {
    if (event.runtimeGeneration !== null && event.runtimeGeneration !== 1)
      invalid(path, "static trace requires generation one");
    if (
      ["fault-decision", "link-send", "control-receipt"].includes(event.kind) ||
      event.kind.startsWith("retry-")
    )
      invalid(
        path,
        "static trace does not admit faults, retries or control traffic",
      );
    if (event.kind === "action") {
      this.actions.push(event);
      if (!staticActionKinds.includes(String(event.data.actionKind)))
        invalid(path, "unsupported static action");
      if (event.data.actionKind === "source-send")
        this.sends.set(String(event.data.actionId), event);
    }
    if (event.kind === "delivered" && event.data.channel === "source-receipt")
      this.receipts.push({
        eventId: event.id,
        actor: event.actor,
        atMs: event.timeMs,
        envelope: event.data.envelope,
      });
    if (
      event.kind !== "assertion" ||
      !["source-accepted", "runtime-data"].includes(
        String(event.data.assertionKind),
      )
    )
      return;
    this.assertions.push(event);
    if (event.data.assertionKind !== "source-accepted") return;
    const send = this.sends.get(String(event.data.send));
    if (
      !send ||
      send.actor !== event.actor ||
      send.timeMs !== event.timeMs ||
      send.data.publication !== event.data.publication ||
      [...this.sends.values()].filter(
        (value) => value.actor === event.actor && value.timeMs === event.timeMs,
      ).length !== 1
    )
      invalid(
        path,
        "acceptance must reference the actor's sole send at this timestamp",
      );
    const receipts = this.receipts.filter(
      (value) => value.actor === event.actor && value.atMs === event.timeMs,
    );
    const matched =
      acceptedReceipt(receipts, event.data.identity, this.used) ?? null;
    if (
      matched !== event.data.receiptEventId ||
      matched !== event.parent ||
      event.data.actual !== (matched !== null)
    )
      invalid(
        path,
        "acceptance result differs from delivered receipt identity, status or count",
      );
    if (matched) this.used.add(matched);
  }
}
