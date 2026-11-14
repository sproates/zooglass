import { orderProfile } from "./evidence-versions.js";
import { isRuntimeAction } from "./event-schema.js";
import { encodeJson, type Json } from "./json.js";
import type { TraceEvent } from "./trace-generations.js";
import { integer, invalid, object } from "./validation.js";

const controlChannel = (value: Json) =>
  value === "progress-request" || value === "progress-receipt";
const sameOwner = (a: TraceEvent, b: TraceEvent) =>
  a.actor === b.actor &&
  a.connectionGeneration === b.connectionGeneration &&
  a.runtimeGeneration === b.runtimeGeneration;

/** Endpoint-specific lineage, independent of replay execution and publication retry identities. */
export class TraceControls {
  private readonly events = new Map<string, TraceEvent>();
  private readonly used = new Set<string>();
  private readonly messageIds = new Set<string>();
  private readonly pending = new Map<string, TraceEvent>();
  private readonly observations = new Map<string, Json[]>();
  private readonly closedConnections = new Set<string>();
  readonly actions: TraceEvent[] = [];
  readonly assertions: TraceEvent[] = [];
  constructor(private readonly profile: Json | undefined) {}

  accept(event: TraceEvent, path: string) {
    const { kind, data, parent } = event;
    const controlAction =
      kind === "action" && data.actionKind === "progress-send";
    const controlAssertion =
      kind === "assertion" && data.assertionKind === "control-receipts";
    const packet =
      ["link-send", "delivered", "dropped"].includes(kind) &&
      controlChannel(data.channel);
    const control =
      controlAction || controlAssertion || packet || kind === "control-receipt";
    if (control && this.profile !== orderProfile)
      invalid(path, "progress evidence requires the SQLite Order profile");
    const connection = JSON.stringify([
      event.actor,
      event.runtimeGeneration,
      event.connectionGeneration,
    ]);
    if (kind === "connection-closed") this.closedConnections.add(connection);
    // Cancellation records may follow closure; fresh traffic cannot reuse that session.
    if (
      control &&
      !controlAssertion &&
      kind !== "dropped" &&
      this.closedConnections.has(connection)
    )
      invalid(
        path,
        "progress traffic cannot use a closed connection generation",
      );
    if (
      this.profile === orderProfile &&
      kind === "action" &&
      typeof data.actionKind === "string" &&
      isRuntimeAction(data.actionKind)
    )
      invalid(
        path,
        "SQLite Order does not support runtime lifecycle or wall clock actions",
      );
    const owner = parent === null ? undefined : this.events.get(parent);
    if (controlAction) {
      if (
        parent !== null ||
        event.causes.length ||
        event.key[1] !== 0 ||
        event.key[2] !== 2 ||
        event.connectionGeneration === null ||
        event.runtimeGeneration !== 1
      )
        invalid(
          path,
          "progress action requires a declared phase-two root and live connection",
        );
      this.actions.push(event);
      this.pending.set(event.id, event);
    } else if (kind === "control-receipt") {
      if (
        !owner ||
        !sameOwner(event, owner) ||
        !sameKey(event, owner) ||
        !(
          (owner.kind === "action" &&
            owner.data.actionKind === "progress-send") ||
          (owner.kind === "delivered" &&
            owner.data.channel === "progress-request")
        )
      )
        invalid(
          path,
          "control receipt must identify its initiating request and connection",
        );
      this.consume(owner, path);
      this.newMessage(event, path);
      const request = object(
        owner.kind === "action" ? owner.data.control : owner.data.envelope,
        path,
      );
      const ack = object(data.envelope, path);
      if (ack.reason !== "invalidProgress") {
        const stream = object(ack.stream, path);
        if (
          ["sourceId", "epoch", "sourceEntityId"].some(
            (key) => stream[key] !== request[key],
          ) ||
          encodeJson(ack.throughSequence) !==
            encodeJson(request.throughSequence)
        )
          invalid(path, "control receipt identity differs from its request");
      }
      this.pending.set(event.id, event);
    } else if (packet) {
      if (kind === "link-send") {
        const request = data.channel === "progress-request";
        if (
          !owner ||
          !sameOwner(event, owner) ||
          !sameKey(event, owner) ||
          (request
            ? owner.kind !== "action" ||
              owner.data.actionKind !== "progress-send"
            : owner.kind !== "control-receipt")
        )
          invalid(
            path,
            "progress link must identify its request or receipt owner",
          );
        if (
          encodeJson(data.envelope) !==
            encodeJson(request ? owner.data.control : owner.data.envelope) ||
          (!request && data.messageId !== owner.data.messageId)
        )
          invalid(path, "progress link changed its owned message");
        if (integer(data.deliverAtMs, path) <= event.timeMs)
          invalid(path, "progress link requires positive latency");
        this.consume(owner, path);
        if (request) this.newMessage(event, path);
        this.pending.set(event.id, event);
      } else {
        const origin =
          kind === "delivered"
            ? owner
            : owner && this.pending.has(owner.id)
              ? owner
              : this.origin(event);
        if (
          !origin ||
          !sameOwner(event, origin) ||
          !(
            (origin.kind === "link-send" &&
              origin.data.channel === data.channel) ||
            (origin.kind === "control-receipt" &&
              data.channel === "progress-receipt")
          ) ||
          origin.data.messageId !== data.messageId ||
          encodeJson(origin.data.envelope) !== encodeJson(data.envelope)
        )
          invalid(
            path,
            "progress delivery must preserve its owned message and connection",
          );
        if (kind === "delivered") {
          if (
            origin.kind === "link-send" &&
            integer(origin.data.deliverAtMs, path) !== event.timeMs
          )
            invalid(
              path,
              "progress delivery differs from its scheduled arrival",
            );
          if (
            origin.kind === "control-receipt" &&
            origin.timeMs !== event.timeMs
          )
            invalid(path, "zero-latency control receipt changed delivery time");
          if (data.channel === "progress-request")
            this.pending.set(event.id, event);
          else {
            const observed = this.observations.get(event.actor) ?? [];
            observed.push(data.envelope);
            this.observations.set(event.actor, observed);
          }
        } else {
          const closed =
            owner?.kind === "connection-closed"
              ? owner
              : event.causes
                  .map((id) => this.events.get(id))
                  .find((cause) => cause?.kind === "connection-closed");
          if (
            data.reason !== "connection-closed" ||
            !closed ||
            !sameOwner(event, closed) ||
            closed.timeMs !== event.timeMs ||
            (origin.kind === "link-send" && !sameKey(event, closed))
          )
            invalid(
              path,
              "progress cancellation requires its connection close cause",
            );
        }
        this.consume(origin, path);
      }
    } else if (controlAssertion) {
      if (
        encodeJson(data.actual) !==
        encodeJson(this.observations.get(event.actor) ?? [])
      )
        invalid(
          path,
          "control assertion actual differs from delivered acknowledgements",
        );
      this.assertions.push(event);
    }
    this.events.set(event.id, event);
  }
  private origin(event: TraceEvent) {
    return event.causes
      .map((id) => this.events.get(id))
      .find(
        (origin) =>
          origin &&
          this.pending.has(origin.id) &&
          origin.data.messageId === event.data.messageId,
      );
  }
  private newMessage(event: TraceEvent, path: string) {
    const id = String(event.data.messageId);
    if (this.messageIds.has(id))
      invalid(path, "progress message identity was reused");
    this.messageIds.add(id);
  }
  private consume(event: TraceEvent, path: string) {
    if (this.used.has(event.id) || !this.pending.delete(event.id))
      invalid(path, "progress message owner was already consumed");
    this.used.add(event.id);
  }
  finish(outcome: string) {
    if (outcome === "passed" && this.pending.size)
      invalid(
        "trace result",
        "passing progress trace retains unfinished control work",
      );
  }
}
function sameKey(a: TraceEvent, b: TraceEvent) {
  return a.key.every((value, i) => value === b.key[i]);
}
