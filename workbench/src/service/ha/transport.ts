import https from "node:https";
import http from "node:http";
import WebSocket, { type RawData } from "ws";
import {
  AccessFailure,
  mediaType,
  ProtocolFailure,
  subprotocol,
} from "./protocol.js";

export interface Channel {
  send(message: string): void;
  next(signal: AbortSignal): Promise<string>;
  close(): void;
}
export interface HttpReply {
  status: number;
  contentType?: string;
  body: string;
}
export interface Transport {
  connect(
    origin: string,
    path: "/views/live" | "/events",
    signal: AbortSignal,
  ): Promise<Channel>;
  read(origin: string, path: string, signal: AbortSignal): Promise<HttpReply>;
}
export interface NodeTransportSettings {
  origins: readonly string[];
  maxBytes: number;
  bearer?: string;
  ca?: string | Buffer;
  /** Only trusted producer processes may enable plaintext local operator access. */
  localOperator?: boolean;
  originHeader?: string;
}
export function trustedOrigins(
  origins: readonly string[],
  localOperator = false,
): string[] {
  if (
    origins.length < 1 ||
    origins.length > 2 ||
    new Set(origins).size !== origins.length
  ) {
    throw new Error("Configure one stable origin or two distinct candidates");
  }
  const normalised = origins.map((raw) => {
    const url = new URL(raw);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(
          localOperator &&
          url.protocol === "http:" &&
          url.hostname === "127.0.0.1"
        ))
    ) {
      throw new Error(
        "Expected a trusted HTTPS origin or explicit loopback operator origin",
      );
    }
    return url.origin;
  });
  if (new Set(normalised).size !== normalised.length) {
    throw new Error("Configure distinct candidate origins");
  }
  return normalised;
}
export function byteBound(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 16 * 1024 * 1024) {
    throw new Error("Byte limit must be between 1 and 16777216");
  }
  return bytes;
}
function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProtocolFailure("Invalid UTF-8");
  }
}
function terminalStatus(status: number): Error {
  return status === 401 || status === 403
    ? new AccessFailure("Access refused")
    : (status >= 300 && status < 500) || status === 505
      ? new ProtocolFailure("Negotiation or routing refused")
      : new Error("Service unavailable");
}
function networkError(error: Error & { code?: string }): Error {
  if (
    (error.code && /WS_ERR_/.test(error.code)) ||
    /^(Server sent no subprotocol|Server sent an invalid subprotocol|Server sent a subprotocol but none was requested)/.test(
      error.message,
    )
  ) {
    return new ProtocolFailure("Invalid or oversized WebSocket frame");
  }
  if (
    error.code &&
    /CERT|TLS|VERIFY|SELF_SIGNED|^INVALID_(CA|PURPOSE)$|^PATH_LENGTH_EXCEEDED$|^CRL_/.test(
      error.code,
    )
  ) {
    return new AccessFailure("TLS verification failed");
  }
  const transient = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "EPIPE",
    "ECONNABORTED",
    "ERR_STREAM_PREMATURE_CLOSE",
    "ABORT_ERR",
  ]);
  return error.code && transient.has(error.code)
    ? error
    : new ProtocolFailure("Transport handshake or verification failed");
}

class NodeChannel implements Channel {
  private queue: Buffer[] = [];
  private bytes = 0;
  private failure?: Error;
  private waiting?: {
    resolve: (raw: string) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  };
  constructor(
    private readonly socket: WebSocket,
    private readonly limit: number,
  ) {
    socket.on("message", (data: RawData, binary: boolean) => {
      try {
        if (binary) {
          throw new ProtocolFailure("Binary application message");
        }
        const buffer = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data as ArrayBuffer);
        if (buffer.length > limit) {
          throw new ProtocolFailure("Frame exceeds byte limit");
        }
        const raw = decodeUtf8(buffer);
        if (this.waiting) {
          const waiter = this.waiting;
          this.waiting = undefined;
          waiter.cleanup();
          waiter.resolve(raw);
        } else {
          if (
            this.queue.length >= 16 ||
            this.bytes + buffer.length > limit * 2
          ) {
            throw new ProtocolFailure("Inbound queue capacity exceeded");
          }
          this.queue.push(buffer);
          this.bytes += buffer.length;
        }
      } catch (error) {
        this.fail(error as Error);
      }
    });
    socket.on("error", (error) => this.fail(networkError(error)));
    socket.on("close", (code) =>
      this.fail(
        code === 1008
          ? new AccessFailure("Socket access lost")
          : [1002, 1003, 1009].includes(code)
            ? new ProtocolFailure("Socket protocol or capacity refused")
            : new Error("Socket closed"),
      ),
    );
  }
  private fail(error: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    this.queue = [];
    this.bytes = 0;
    const waiter = this.waiting;
    this.waiting = undefined;
    if (waiter) {
      waiter.cleanup();
      waiter.reject(error);
    }
    this.socket.terminate();
  }
  send(message: string): void {
    if (this.failure) {
      throw this.failure;
    }
    if (
      Buffer.byteLength(message) > this.limit ||
      this.socket.bufferedAmount > this.limit
    ) {
      throw new ProtocolFailure("Outbound capacity exceeded");
    }
    this.socket.send(message, (error) => {
      if (error) {
        this.fail(error);
      }
    });
  }
  next(signal: AbortSignal): Promise<string> {
    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (this.waiting) {
      return Promise.reject(new Error("Only one socket reader is permitted"));
    }
    const first = this.queue.shift();
    if (first) {
      this.bytes -= first.length;
      return Promise.resolve(decodeUtf8(first));
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiting = undefined;
        reject(signal.reason);
      };
      const cleanup = () => signal.removeEventListener("abort", abort);
      this.waiting = { resolve, reject, cleanup };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  close(): void {
    this.fail(new Error("Client closed connection"));
  }
}

/** Verified TLS only; no redirects, implicit origin discovery or cross-origin credential forwarding. */
export class NodeTransport implements Transport {
  readonly origins: readonly string[];
  private readonly allowed: ReadonlySet<string>;
  private readonly settings: Readonly<NodeTransportSettings>;
  private readonly limit: number;
  constructor(settings: NodeTransportSettings) {
    this.origins = Object.freeze(
      trustedOrigins(settings.origins, settings.localOperator),
    );
    this.allowed = new Set(this.origins);
    this.settings = Object.freeze({
      ...settings,
      origins: this.origins,
      ca: Buffer.isBuffer(settings.ca) ? Buffer.from(settings.ca) : settings.ca,
    });
    this.limit = byteBound(settings.maxBytes);
  }
  private url(origin: string, path: string): URL {
    const url = new URL(path, origin);
    if (
      !this.allowed.has(url.origin) ||
      url.origin !== origin ||
      !path.startsWith("/") ||
      path.startsWith("//")
    ) {
      throw new Error("Untrusted destination");
    }
    return url;
  }
  private headers(): Record<string, string> {
    return {
      ...(this.settings.bearer
        ? { Authorization: `Bearer ${this.settings.bearer}` }
        : {}),
      ...(this.settings.originHeader
        ? { Origin: this.settings.originHeader }
        : {}),
    };
  }
  connect(
    origin: string,
    path: "/views/live" | "/events",
    signal: AbortSignal,
  ): Promise<Channel> {
    const url = this.url(origin, path);
    if (this.settings.localOperator && path !== "/events") {
      throw new Error("Operator transport cannot request viewer data");
    }
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const socket = new WebSocket(url, subprotocol, {
        headers: this.headers(),
        ca: this.settings.ca,
        rejectUnauthorized: true,
        followRedirects: false,
        maxPayload: this.limit,
        perMessageDeflate: false,
      });
      const channel = new NodeChannel(socket, this.limit);
      let settled = false;
      const cleanup = () => signal.removeEventListener("abort", abort);
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          channel.close();
          reject(error);
        }
      };
      const abort = () => fail(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      socket.once("error", (error) => fail(networkError(error)));
      socket.once("unexpected-response", (_request, response) => {
        response.destroy();
        fail(terminalStatus(response.statusCode ?? 500));
      });
      socket.once("close", () =>
        fail(new Error("Connection closed before negotiation")),
      );
      socket.once("open", () => {
        if (socket.protocol !== subprotocol) {
          fail(new ProtocolFailure("HA subprotocol was not selected"));
          return;
        }
        if (!settled) {
          settled = true;
          cleanup();
          resolve(channel);
        }
      });
    });
  }
  read(origin: string, path: string, signal: AbortSignal): Promise<HttpReply> {
    if (this.settings.localOperator) {
      throw new Error("Operator transport cannot request viewer data");
    }
    const url = this.url(origin, path);
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const request = (url.protocol === "https:" ? https : http).get(
        url,
        {
          headers: { ...this.headers(), Accept: mediaType },
          ca: this.settings.ca,
          rejectUnauthorized: true,
          signal,
        },
        (response) => {
          const status = response.statusCode ?? 500;
          if (status !== 200 && status !== 404) {
            response.destroy();
            reject(terminalStatus(status));
            return;
          }
          if (
            response.headers["content-type"]
              ?.split(";")[0]
              .trim()
              .toLowerCase() !== mediaType ||
            (response.headers["content-encoding"] &&
              response.headers["content-encoding"] !== "identity")
          ) {
            response.destroy();
            reject(new ProtocolFailure("HTTP negotiation failed"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > this.limit) {
              const failure = new ProtocolFailure(
                "HTTP response exceeds byte limit",
              );
              reject(failure);
              response.destroy(failure);
              return;
            }
            chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("aborted", () =>
            reject(new Error("Incomplete HTTP response")),
          );
          response.once("end", () => {
            try {
              resolve({
                status,
                contentType: response.headers["content-type"],
                body: decodeUtf8(Buffer.concat(chunks)),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.once("error", (error) => reject(networkError(error)));
    });
  }
}
