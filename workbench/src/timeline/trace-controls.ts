import {
  orderProfile,
  orderRestartProfile,
  hasProgressControl,
  sportsProfile,
} from "./evidence-versions.js";
import { controlRequestMatches } from "./control-contract.js";
import { isRuntimeAction } from "./event-schema.js";
import { encodeJson, type Json } from "./json.js";
import type { TraceEvent } from "./trace-generations.js";
import { integer, invalid, object } from "./validation.js";

const controlChannel = (value: Json) =>
  [
    "progress-request",
    "progress-receipt",
    "retirement-request",
    "retirement-receipt",
  ].includes(String(value));
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
  private readonly stoppedGenerations = new Set<number>();
  private readonly closedConnections = new Set<string>();
  readonly actions: TraceEvent[] = [];
  readonly assertions: TraceEvent[] = [];
  constructor(private readonly profile: Json | undefined) {}

  accept(event: TraceEvent, path: string) {
    const { kind, data, parent } = event;
    const controlAction =
      kind === "action" &&
      (data.actionKind === "progress-send" ||
        data.actionKind === "retirement-send");
    const controlAssertion =
      kind === "assertion" && data.assertionKind === "control-receipts";
    const packet =
      ["link-send", "delivered", "dropped"].includes(kind) &&
      controlChannel(data.channel);
    const control =
      controlAction || controlAssertion || packet || kind === "control-receipt";
    if (control && !hasProgressControl(this.profile))
      invalid(
        path,
        "control evidence requires the SQLite Order or Sports profile",
      );
    const retirement =
      data.actionKind === "retirement-send" ||
      String(data.channel).startsWith("retirement-") ||
      (kind === "control-receipt" &&
        object(data.envelope, path).kind === "factRetirement") ||
      (controlAssertion &&
        [...(data.expected as Json[]), ...(data.actual as Json[])].some(
          (value) => object(value, path).kind === "factRetirement",
        ));
    if (retirement && this.profile !== sportsProfile)
      invalid(path, "retirement evidence requires the SQLite Sports profile");
    const connection = JSON.stringify([
      event.actor,
      event.runtimeGeneration,
      event.connectionGeneration,
    ]);
    if (kind === "connection-closed") this.closedConnections.add(connection);
    if (
      kind === "action" &&
      data.actionKind === "service-stop" &&
      event.runtimeGeneration !== null
    )
      this.stoppedGenerations.add(event.runtimeGeneration);
    // Cancellation records may follow closure; fresh traffic cannot reuse that session.
    if (
      control &&
      !controlAssertion &&
      kind !== "dropped" &&
      (this.closedConnections.has(connection) ||
        (event.runtimeGeneration !== null &&
          this.stoppedGenerations.has(event.runtimeGeneration)))
    )
      invalid(
        path,
        "control traffic cannot use a closed connection generation",
      );
    if (
      (this.profile === orderProfile || this.profile === sportsProfile) &&
      kind === "action" &&
      typeof data.actionKind === "string" &&
      isRuntimeAction(data.actionKind)
    )
      invalid(
        path,
        "SQLite Order does not support runtime lifecycle or wall clock actions",
      );
    if (
      this.profile === orderRestartProfile &&
      kind === "action" &&
      data.actionKind === "wall-clock-set"
    )
      invalid(
        path,
        "SQLite Order lifecycle does not support wall clock actions",
      );
    const owner = parent === null ? undefined : this.events.get(parent);
    if (controlAction) {
      if (
        parent !== null ||
        event.causes.length ||
        event.key[1] !== 0 ||
        event.key[2] !== 2 ||
        event.connectionGeneration === null ||
        event.runtimeGeneration === null ||
        ((this.profile === orderProfile || this.profile === sportsProfile) &&
          event.runtimeGeneration !== 1)
      )
        invalid(
          path,
          "control action requires a declared phase-two root and live connection",
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
            (owner.data.actionKind === "progress-send" ||
              owner.data.actionKind === "retirement-send")) ||
          (owner.kind === "delivered" &&
            (owner.data.channel === "progress-request" ||
              owner.data.channel === "retirement-request"))
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
      const retirementOwner =
        owner.data.actionKind === "retirement-send" ||
        owner.data.channel === "retirement-request";
      if (
        (ack.kind === "factRetirement") !== retirementOwner ||
        !controlRequestMatches(request, ack)
      )
        invalid(path, "control receipt identity differs from its request");
      this.pending.set(event.id, event);
    } else if (packet) {
      if (kind === "link-send") {
        const request =
          data.channel === "progress-request" ||
          data.channel === "retirement-request";
        if (
          !owner ||
          !sameOwner(event, owner) ||
          !sameKey(event, owner) ||
          (request
            ? owner.kind !== "action" ||
              owner.data.actionKind !==
                (data.channel === "retirement-request"
                  ? "retirement-send"
                  : "progress-send")
            : owner.kind !== "control-receipt" ||
              (object(owner.data.envelope, path).kind === "factRetirement") !==
                (data.channel === "retirement-receipt"))
        )
          invalid(
            path,
            "control link must identify its request or receipt owner",
          );
        if (
          encodeJson(data.envelope) !==
            encodeJson(request ? owner.data.control : owner.data.envelope) ||
          (!request && data.messageId !== owner.data.messageId)
        )
          invalid(path, "control link changed its owned message");
        if (integer(data.deliverAtMs, path) <= event.timeMs)
          invalid(path, "control link requires positive latency");
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
              data.channel ===
                (object(origin.data.envelope, path).kind === "factRetirement"
                  ? "retirement-receipt"
                  : "progress-receipt"))
          ) ||
          origin.data.messageId !== data.messageId ||
          encodeJson(origin.data.envelope) !== encodeJson(data.envelope)
        )
          invalid(
            path,
            "control delivery must preserve its owned message and connection",
          );
        if (kind === "delivered") {
          if (
            origin.kind === "link-send" &&
            integer(origin.data.deliverAtMs, path) !== event.timeMs
          )
            invalid(
              path,
              "control delivery differs from its scheduled arrival",
            );
          if (
            origin.kind === "control-receipt" &&
            origin.timeMs !== event.timeMs
          )
            invalid(path, "zero-latency control receipt changed delivery time");
          if (
            data.channel === "progress-request" ||
            data.channel === "retirement-request"
          )
            this.pending.set(event.id, event);
          else {
            const observed = this.observations.get(event.actor) ?? [];
            observed.push(data.envelope);
            this.observations.set(event.actor, observed);
          }
        } else {
          this.cancellation(event, origin, owner, path);
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
  private cancellation(
    event: TraceEvent,
    origin: TraceEvent,
    owner: TraceEvent | undefined,
    path: string,
  ) {
    const causes = [owner, ...event.causes.map((id) => this.events.get(id))];
    const closed = causes.find((cause) => cause?.kind === "connection-closed");
    const stopped = causes.find(
      (cause) =>
        cause?.kind === "action" && cause.data.actionKind === "service-stop",
    );
    const connectionClose =
      closed &&
      sameOwner(event, closed) &&
      closed.timeMs === event.timeMs &&
      (origin.kind !== "link-send" || sameKey(event, closed));
    const serviceStop =
      this.profile === orderRestartProfile &&
      stopped &&
      stopped.actor === "@runtime" &&
      stopped.connectionGeneration === null &&
      stopped.runtimeGeneration === event.runtimeGeneration &&
      sameKey(event, stopped);
    if (
      event.data.reason !== "connection-closed" ||
      (!connectionClose && !serviceStop)
    )
      invalid(
        path,
        "control cancellation requires its connection close or admitted service stop cause",
      );
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
      invalid(path, "control message identity was reused");
    this.messageIds.add(id);
  }
  private consume(event: TraceEvent, path: string) {
    if (this.used.has(event.id) || !this.pending.delete(event.id))
      invalid(path, "control message owner was already consumed");
    this.used.add(event.id);
  }
  finish(outcome: string) {
    if (outcome === "passed" && this.pending.size)
      invalid(
        "trace result",
        "passing control trace retains unfinished control work",
      );
  }
}
function sameKey(a: TraceEvent, b: TraceEvent) {
  return a.key.every((value, i) => value === b.key[i]);
}
