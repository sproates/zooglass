import assert from "node:assert/strict";
import https from "node:https";
import { decode, type Envelope } from "../service/ha/protocol.js";
import {
  NodeTransport,
  type Channel,
  type Transport,
} from "../service/ha/transport.js";
import { type CaseContext, maxBytes, resource, transport } from "./context.js";

export function signal(ctx: CaseContext, milliseconds = 5000) {
  return AbortSignal.any([ctx.signal, AbortSignal.timeout(milliseconds)]);
}
export async function next(
  ctx: CaseContext,
  channel: Channel,
): Promise<Envelope> {
  const frame = decode(await channel.next(signal(ctx)), maxBytes);
  assert.ok(!("error" in frame));
  return frame;
}
export async function source(ctx: CaseContext, index: number) {
  const channel = await transport(ctx).connect(
    ctx.cluster.nodes[index].viewer,
    "/events",
    signal(ctx),
  );
  assert.equal((await next(ctx, channel)).kind, "hello");
  return channel;
}
export async function subscription(ctx: CaseContext, index: number) {
  const channel = await transport(ctx).connect(
    ctx.cluster.nodes[index].viewer,
    "/views/live",
    signal(ctx),
  );
  const hello = await next(ctx, channel);
  assert.equal(hello.kind, "hello");
  channel.send(
    JSON.stringify({ action: "subscribe", subscription: "1", ...resource }),
  );
  const subscribed = await next(ctx, channel);
  assert.equal(subscribed.kind, "subscribed");
  const baseline = await next(ctx, channel);
  assert.equal(baseline.kind, "baseline");
  return { channel, baseline, hello, subscribed };
}
export function rawGet(
  ctx: CaseContext,
  origin: string,
  path: string,
  bearer = "viewer",
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = https.get(
      origin + path,
      {
        agent: false,
        ca: ctx.cluster.ca,
        rejectUnauthorized: true,
        signal: signal(ctx),
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: "application/vnd.zooglass.ha-v1+json",
          Origin: "https://fixture-viewer.example",
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += String(chunk);
          if (body.length > maxBytes)
            response.destroy(new Error("Reply too large"));
        });
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("Incomplete response")));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body }),
        );
      },
    );
    request.on("error", reject);
  });
}
/** Withhold an actual admitted receipt from the client, rather than manufacturing a commit result. */
export class LostReceipt implements Transport {
  readonly observed: {
    promise: Promise<Envelope>;
    resolve: (value: Envelope) => void;
  } = (() => {
    let resolve!: (value: Envelope) => void;
    const promise = new Promise<Envelope>((yes) => {
      resolve = yes;
    });
    return { promise, resolve };
  })();
  private armed = true;
  constructor(private readonly delegate: NodeTransport) {}
  read: Transport["read"] = (...args) => this.delegate.read(...args);
  async connect(...args: Parameters<Transport["connect"]>): Promise<Channel> {
    const channel = await this.delegate.connect(...args);
    return {
      send: (raw) => channel.send(raw),
      close: () => channel.close(),
      next: async (abort) => {
        const raw = await channel.next(abort);
        const frame = decode(raw, maxBytes);
        if (this.armed && !("error" in frame) && frame.kind === "receipt") {
          this.armed = false;
          this.observed.resolve(frame);
          return new Promise<string>((_resolve, reject) => {
            if (abort.aborted) reject(abort.reason);
            else
              abort.addEventListener("abort", () => reject(abort.reason), {
                once: true,
              });
          });
        }
        return raw;
      },
    };
  }
}
