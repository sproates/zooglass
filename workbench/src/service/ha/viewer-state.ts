import { Ownership } from "./ownership.js";
import {
  ProtocolFailure,
  OrderingFailure,
  maximumCounter,
  object,
  text,
  type Envelope,
  type ObjectValue,
  type Refusal,
} from "./protocol.js";

export interface Resource {
  viewId: string;
  entityId: string;
}
export function resourceKey(resource: Resource): string {
  return JSON.stringify([resource.viewId, resource.entityId]);
}
interface Membership {
  resource: Resource;
  id: string;
  stage: "pending" | "acknowledged" | "live";
  revision?: bigint;
}
export interface ReadTicket {
  readonly generation: bigint;
  readonly key: string;
  readonly sequence: number;
  readonly presentation: object;
  readonly epoch: object;
}
export type ViewerEvent =
  | { type: "snapshot"; resource: Resource; value: ObjectValue }
  | { type: "clear" }
  | { type: "refused"; resource: Resource; reason: string };

/** Ordering state only. Transport epochs and resource presentation epochs are independent. */
export class ViewerState {
  private epoch: object = {};
  private socketGeneration?: bigint;
  private lastSubscription = 0n;
  private pending?: { action: "subscribe" | "unsubscribe"; member: Membership };
  private readonly members = new Map<string, Membership>();
  private readonly presentations = new Map<string, object>();
  private readonly reads = new Map<string, number>();
  private readonly removeObserver: () => void;
  constructor(
    readonly ownership: Ownership,
    private readonly maxResources: number,
    private readonly emit: (event: ViewerEvent) => void,
  ) {
    if (!Number.isSafeInteger(maxResources) || maxResources < 1) {
      throw new Error("A positive resource bound is required");
    }
    this.removeObserver = ownership.listen(() => {
      if (
        ownership.signal.aborted ||
        (this.socketGeneration !== undefined &&
          this.socketGeneration < ownership.generation)
      ) {
        this.retire();
      }
    });
  }
  get token(): object {
    return this.epoch;
  }
  get ready(): boolean {
    return this.socketGeneration !== undefined;
  }
  get commandPending(): boolean {
    return this.pending !== undefined;
  }
  isCurrent(token: object): boolean {
    return token === this.epoch;
  }
  retire(): void {
    this.epoch = {};
    this.socketGeneration = undefined;
    this.lastSubscription = 0n;
    this.pending = undefined;
    this.members.clear();
    this.presentations.clear();
    this.reads.clear();
    this.emit({ type: "clear" });
  }
  close(): void {
    this.retire();
    this.removeObserver();
  }
  private present(key: string): object {
    let marker = this.presentations.get(key);
    if (!marker) {
      if (this.presentations.size >= this.maxResources) {
        throw new Error("Resource capacity exceeded");
      }
      marker = {};
      this.presentations.set(key, marker);
    }
    return marker;
  }
  forget(resource: Resource): void {
    const key = resourceKey(resource);
    if (this.members.has(key)) {
      throw new Error("Unsubscribe before forgetting a resource");
    }
    this.presentations.delete(key);
    this.reads.delete(key);
  }
  command(action: "subscribe" | "unsubscribe", resource: Resource): string {
    this.ownership.assertAvailable();
    if (!this.ready || this.pending) {
      throw new Error("Viewer is not ready for a command");
    }
    const key = resourceKey(resource);
    let member = this.members.get(key);
    if (action === "subscribe") {
      if (this.lastSubscription === maximumCounter) {
        throw new ProtocolFailure("Subscription counter exhausted");
      }
      this.present(key);
      member = {
        resource: { viewId: resource.viewId, entityId: resource.entityId },
        id: String(++this.lastSubscription),
        stage: "pending",
      };
      this.members.set(key, member);
      this.presentations.set(key, {});
    } else if (!member || member.stage !== "live") {
      throw new Error("No live membership");
    }
    this.pending = { action, member: member! };
    return JSON.stringify({
      action,
      subscription: member!.id,
      viewId: resource.viewId,
      entityId: resource.entityId,
    });
  }
  receive(token: object, frame: Envelope | Refusal): void {
    if (!this.isCurrent(token)) {
      return;
    }
    if ("error" in frame) {
      const pending = this.pending;
      if (
        !pending ||
        pending.action !== "subscribe" ||
        frame.subscription !== pending.member.id
      ) {
        throw new ProtocolFailure("Unsolicited subscription refusal");
      }
      this.members.delete(resourceKey(pending.member.resource));
      this.pending = undefined;
      this.emit({
        type: "refused",
        resource: pending.member.resource,
        reason: frame.error,
      });
      return;
    }
    if (
      this.ownership.incarnation !== undefined &&
      frame.incarnation !== this.ownership.incarnation
    ) {
      this.ownership.rejectIncarnation();
    }
    if (frame.kind === "hello") {
      if (this.socketGeneration !== undefined) {
        throw new ProtocolFailure("Repeated hello");
      }
      this.socketGeneration = frame.generation;
      if (!this.ownership.observe(frame)) {
        this.retire();
        throw new Error("Stale owner hello");
      }
      return;
    }
    if (
      this.socketGeneration === undefined ||
      frame.generation !== this.socketGeneration ||
      !this.ownership.observe(frame)
    ) {
      throw new ProtocolFailure("Wrong socket generation");
    }
    const p = frame.payload;
    if (frame.kind === "requestError") {
      const pending = this.pending;
      if (
        !pending ||
        (p.subscription !== null && p.subscription !== pending.member.id)
      ) {
        throw new ProtocolFailure("Unsolicited request error");
      }
      if (pending.action === "subscribe") {
        this.members.delete(resourceKey(pending.member.resource));
      }
      this.pending = undefined;
      this.emit({
        type: "refused",
        resource: pending.member.resource,
        reason: text(p.code),
      });
      return;
    }
    if (
      !["subscribed", "baseline", "update", "unsubscribed"].includes(frame.kind)
    ) {
      throw new ProtocolFailure("Unexpected viewer message");
    }
    const snapshot =
      frame.kind === "baseline" || frame.kind === "update"
        ? object(p.snapshot)
        : p;
    const resource = {
      viewId: text(snapshot.viewId),
      entityId: text(snapshot.entityId),
    };
    const key = resourceKey(resource),
      member = this.members.get(key);
    if (!member || member.id !== p.subscription) {
      return;
    } // Already retired membership.
    if (frame.kind === "subscribed") {
      if (
        member.stage !== "pending" ||
        this.pending?.member !== member ||
        this.pending.action !== "subscribe"
      ) {
        throw new OrderingFailure("Unexpected subscription acknowledgement");
      }
      member.stage = "acknowledged";
      member.revision = frame.contentRevision;
    } else if (frame.kind === "unsubscribed") {
      if (
        this.pending?.member !== member ||
        this.pending.action !== "unsubscribe"
      ) {
        throw new ProtocolFailure("Unexpected unsubscribe acknowledgement");
      }
      this.members.delete(key);
      this.presentations.set(key, {});
      this.pending = undefined;
    } else {
      if (frame.kind === "baseline") {
        if (
          member.stage !== "acknowledged" ||
          member.revision !== frame.contentRevision ||
          this.pending?.member !== member
        ) {
          throw new OrderingFailure("Inconsistent baseline");
        }
        member.stage = "live";
        this.pending = undefined;
      } else if (
        member.stage !== "live" ||
        frame.contentRevision < member.revision!
      ) {
        throw new OrderingFailure("Unordered live update");
      }
      member.revision = frame.contentRevision;
      this.presentations.set(key, {});
      this.emit({ type: "snapshot", resource, value: snapshot });
    }
  }
  beginRead(resource: Resource): ReadTicket {
    this.ownership.assertAvailable();
    const key = resourceKey(resource),
      presentation = this.present(key);
    const sequence = (this.reads.get(key) ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) {
      throw new Error("Read sequence exhausted; retire this client");
    }
    this.reads.set(key, sequence);
    return {
      key,
      sequence,
      presentation,
      epoch: this.epoch,
      generation: this.ownership.generation,
    };
  }
  private currentRead(
    ticket: ReadTicket,
    generation = ticket.generation,
  ): boolean {
    return (
      generation >= this.ownership.generation &&
      ticket.epoch === this.epoch &&
      this.reads.get(ticket.key) === ticket.sequence &&
      this.presentations.get(ticket.key) === ticket.presentation
    );
  }
  finishRead(
    ticket: ReadTicket,
    frame: Envelope,
  ): ObjectValue | null | undefined {
    if (!this.currentRead(ticket)) {
      return undefined;
    }
    if (frame.kind !== "snapshot" && frame.kind !== "notFound") {
      throw new ProtocolFailure("Unexpected HTTP message");
    }
    if (
      frame.kind === "snapshot" &&
      resourceKey({
        viewId: text(frame.payload.viewId),
        entityId: text(frame.payload.entityId),
      }) !== ticket.key
    ) {
      throw new ProtocolFailure("Wrong HTTP resource");
    }
    if (
      !this.ownership.observe(frame) ||
      !this.currentRead(ticket, frame.generation)
    ) {
      return undefined;
    }
    if (this.members.has(ticket.key)) {
      return undefined;
    } // A live stream owns its presentation.
    this.presentations.set(ticket.key, {});
    return frame.kind === "notFound" ? null : frame.payload;
  }
  readIsCurrent(ticket: ReadTicket): boolean {
    return this.currentRead(ticket);
  }
}
