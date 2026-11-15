import WebSocket from "ws";

/** Event-driven socket barrier with bounded cancellation and raw wire retention. */
export class ObservedSocket {
  readonly socket: WebSocket;
  readonly raw: string[] = [];
  readonly sent: string[] = [];
  readonly messages: unknown[] = [];
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (bytes) => {
      const raw = bytes.toString();
      this.raw.push(raw);
      try {
        this.messages.push(JSON.parse(raw));
      } catch {
        this.messages.push(raw);
      }
    });
    this.socket.on("error", () => {});
  }
  async wait(predicate: () => boolean, signal: AbortSignal, label: string) {
    signal.throwIfAborted();
    if (predicate()) return;
    await new Promise<void>((done, fail) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.socket
          .off("message", check)
          .off("open", check)
          .off("close", closed)
          .off("error", failed);
        signal.removeEventListener("abort", aborted);
      };
      const failed = (error: unknown) => {
        cleanup();
        fail(error);
      };
      const check = () => {
        try {
          if (predicate()) {
            cleanup();
            done();
          }
        } catch (error) {
          failed(error);
        }
      };
      const closed = () =>
        failed(new Error(`Socket closed waiting for ${label}`));
      const aborted = () => failed(signal.reason);
      const timer = setTimeout(
        () => failed(new Error(`Timed out waiting for ${label}`)),
        5000,
      );
      this.socket
        .on("message", check)
        .on("open", check)
        .on("close", closed)
        .on("error", failed);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      else check();
    });
  }
  send(body: unknown) {
    const raw = JSON.stringify(body);
    this.sent.push(raw);
    this.socket.send(raw);
  }
}
