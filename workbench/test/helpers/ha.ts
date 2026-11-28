import { EventEmitter } from "node:events";
import type {
  Channel,
  HttpReply,
  Transport,
} from "../../src/service/ha/transport.js";
export const incarnation = "11111111-1111-4111-8111-111111111111";
export const otherIncarnation = "22222222-2222-4222-8222-222222222222";
export const resource = { viewId: "v", entityId: "e" };
export const publication =
  '{"sourceId":"s","epoch":"ep","sourceEntityId":"e","publicationSequence":1,"type":"t","payload":{"score":3}}';
export function snapshot(score = 3) {
  return {
    ...resource,
    version: 1,
    data: { score },
    provenance: {},
    publicationSequences: {},
    status: {},
  };
}
export function wire(
  kind: string,
  payload: unknown = {},
  generation = "1",
  revision = "1",
  pin = incarnation,
): string {
  return JSON.stringify({
    kind,
    incarnation: pin,
    generation,
    contentRevision: revision,
    authorityRevision: revision,
    payload,
  });
}
export function receipt(reason = "postgresql", status = "committed") {
  return {
    status,
    reason,
    stream: { sourceId: "s", epoch: "ep", sourceEntityId: "e" },
    publicationSequence: 1,
    version: 1,
    changedViews: ["v"],
    targets: [],
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export class TestChannel implements Channel {
  readonly sent: string[] = [];
  readonly events = new EventEmitter();
  closed = false;
  private queue: string[] = [];
  private waiter?: {
    resolve: (raw: string) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  };
  constructor(
    private readonly onSend: (
      raw: string,
      channel: TestChannel,
    ) => void = () => {},
  ) {}
  push(raw: string): void {
    if (this.closed) return;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter.cleanup();
      waiter.resolve(raw);
    } else this.queue.push(raw);
  }
  send(raw: string): void {
    if (this.closed) throw new Error("closed");
    this.sent.push(raw);
    this.events.emit("sent", raw);
    this.onSend(raw, this);
  }
  next(signal: AbortSignal): Promise<string> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.closed) return Promise.reject(new Error("closed"));
    const raw = this.queue.shift();
    if (raw !== undefined) return Promise.resolve(raw);
    if (this.waiter) throw new Error("concurrent reader");
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiter = undefined;
        reject(signal.reason);
      };
      this.waiter = {
        resolve,
        reject,
        cleanup: () => signal.removeEventListener("abort", abort),
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  close(): void {
    this.closed = true;
    this.queue = [];
    const waiter = this.waiter;
    this.waiter = undefined;
    if (waiter) {
      waiter.cleanup();
      waiter.reject(new Error("closed"));
    }
    this.events.emit("closed");
  }
}
export class TestTransport implements Transport {
  readonly connections: { origin: string; path: string }[] = [];
  readonly reads: { origin: string; path: string; signal: AbortSignal }[] = [];
  constructor(
    readonly channels: TestChannel[] = [],
    public readHandler: (
      signal: AbortSignal,
    ) => Promise<HttpReply> = async () => ({
      status: 200,
      body: wire("snapshot", snapshot()),
    }),
  ) {}
  async connect(
    origin: string,
    path: "/views/live" | "/events",
    signal: AbortSignal,
  ): Promise<Channel> {
    if (signal.aborted) throw signal.reason;
    this.connections.push({ origin, path });
    const channel = this.channels.shift();
    if (!channel) throw new Error("no candidate");
    return channel;
  }
  read(origin: string, path: string, signal: AbortSignal): Promise<HttpReply> {
    this.reads.push({ origin, path, signal });
    return this.readHandler(signal);
  }
}
export function viewerChannel(
  generation = "1",
  pin = incarnation,
): TestChannel {
  const c = new TestChannel((raw, self) => {
    const p = JSON.parse(raw) as {
      action: string;
      subscription: string;
      viewId: string;
      entityId: string;
    };
    if (p.action === "subscribe") {
      self.push(
        wire(
          "subscribed",
          {
            subscription: p.subscription,
            viewId: p.viewId,
            entityId: p.entityId,
            recovery: "freshSnapshot",
          },
          generation,
          "1",
          pin,
        ),
      );
      self.push(
        wire(
          "baseline",
          {
            subscription: p.subscription,
            snapshot: { ...snapshot(), viewId: p.viewId, entityId: p.entityId },
          },
          generation,
          "1",
          pin,
        ),
      );
    } else
      self.push(
        wire(
          "unsubscribed",
          {
            subscription: p.subscription,
            viewId: p.viewId,
            entityId: p.entityId,
          },
          generation,
          "1",
          pin,
        ),
      );
  });
  c.push(wire("hello", {}, generation, "1", pin));
  return c;
}
