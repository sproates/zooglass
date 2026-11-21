import { isRuntimeAction } from "./event-schema.js";
import { recoveryActionKinds } from "./recovery-contract.js";
import {
  acceptedReceipt,
  type DeliveredReceipt,
} from "./projected-assertions.js";
import type { TraceEvent } from "./trace-generations.js";
import { invalid } from "./validation.js";
import { staticActionKinds } from "./static-contract.js";

/** Binds projected receipt assertions to real arrivals, without consuming full observations. */
export class TraceProjections {
  constructor(private readonly recovery = false) {}

  readonly assertions: TraceEvent[] = [];
  readonly actions: TraceEvent[] = [];
  private readonly receipts: DeliveredReceipt[] = [];
  private readonly used = new Set<string>();
  private readonly sends = new Map<string, TraceEvent>();
  private readonly connections = new Map<
    string,
    { runtime: number; connection: number; open: boolean; attached: boolean }
  >();

  accept(event: TraceEvent, path: string) {
    if (
      !this.recovery &&
      event.runtimeGeneration !== null &&
      event.runtimeGeneration !== 1
    )
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
      if (this.recovery && !isRuntimeAction(String(event.data.actionKind))) {
        if (event.runtimeGeneration === null)
          invalid(
            path,
            "static recovery actor actions require a running service",
          );
        if (
          ["source-send", "source-retry"].includes(
            String(event.data.actionKind),
          ) &&
          event.connectionGeneration === null
        )
          invalid(
            path,
            "static recovery publication requires an active connection",
          );
      }
      this.actions.push(event);
      if (
        !(this.recovery ? recoveryActionKinds : staticActionKinds).includes(
          String(event.data.actionKind),
        )
      )
        invalid(path, "unsupported static action");
      if (event.data.actionKind === "source-send")
        this.sends.set(String(event.data.actionId), event);
    }
    if (this.recovery) this.recoveryConnection(event, path);
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
      (this.recovery
        ? this.actions.filter((action) =>
            ["source-send", "source-retry"].includes(
              String(action.data.actionKind),
            ),
          )
        : [...this.sends.values()]
      ).filter(
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

  /** Historical generation ownership alone does not keep a retired session live. */
  private recoveryConnection(event: TraceEvent, path: string) {
    const action = event.kind === "action" ? event.data.actionKind : undefined;
    if (action === "service-stop") {
      for (const connection of this.connections.values()) {
        connection.open = false;
        connection.attached = false;
      }
      return;
    }
    const current = this.connections.get(event.actor);
    if (action === "connect") {
      if (
        current?.attached ||
        event.runtimeGeneration === null ||
        event.connectionGeneration === null
      )
        invalid(path, "connect cannot replace an active connection");
      this.connections.set(event.actor, {
        runtime: event.runtimeGeneration,
        connection: event.connectionGeneration,
        open: true,
        attached: true,
      });
      return;
    }
    const matches =
      current !== undefined &&
      current.runtime === event.runtimeGeneration &&
      current.connection === event.connectionGeneration;
    if (action === "disconnect" || event.kind === "connection-closed") {
      if (!matches) invalid(path, "close must identify the current connection");
      if (action === "disconnect") {
        if (!current.attached)
          invalid(path, "disconnect requires an attached connection");
        current.attached = false;
      }
      current.open = false;
      return;
    }
    const publicationOrSubscription =
      action !== undefined &&
      [
        "source-send",
        "source-retry",
        "client-subscribe",
        "client-unsubscribe",
      ].includes(String(action));
    const traffic = ["receipt", "handoff", "frame", "delivered"].includes(
      event.kind,
    );
    if ((publicationOrSubscription || traffic) && (!matches || !current.open))
      invalid(path, "static recovery traffic requires the active connection");
    // Cumulative assertions and cancellation/drop records may name a closed session.
  }
}
