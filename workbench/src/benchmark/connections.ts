import { once } from "node:events";
import WebSocket from "ws";

/** Own listeners and sockets from construction, including a failed handshake. */
export class Connections {
  private readonly sockets: WebSocket[] = [];
  private closing = false;
  error?: Error;
  constructor(private readonly signal: AbortSignal) {}
  fail(cause: unknown) {
    this.error ??= cause instanceof Error ? cause : new Error(String(cause));
  }
  check() {
    this.signal.throwIfAborted();
    if (this.error) throw this.error;
  }
  async open(
    url: string,
    receive: (value: unknown, atMs: number, bytes: number) => void,
  ) {
    this.check();
    const socket = new WebSocket(url, { maxPayload: 1024 * 1024 });
    this.sockets.push(socket);
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => {
      if (!this.closing)
        this.fail(new Error("Benchmark connection closed unexpectedly"));
    });
    socket.on("message", (bytes) => {
      const atMs = performance.now();
      try {
        receive(
          JSON.parse(bytes.toString()),
          atMs,
          Array.isArray(bytes)
            ? bytes.reduce((n, b) => n + b.length, 0)
            : bytes.byteLength,
        );
      } catch (cause) {
        this.fail(cause);
      }
    });
    await once(socket, "open", {
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(10000)]),
    });
    this.check();
    return socket;
  }
  close() {
    this.closing = true;
    for (const socket of this.sockets) socket.terminate();
  }
}
