import type { ServerResponse } from "node:http";
/** Delayed policy replies stay bounded and are discarded when the peer or fixture closes. */
export class PolicyReplies {
  private readonly waiting = new Map<ServerResponse, () => void>();
  constructor(private readonly capacity = 32) {}
  get pending(): number {
    return this.waiting.size;
  }
  send(
    response: ServerResponse,
    delayMillis: number,
    deliver: () => void,
  ): void {
    if (
      !Number.isInteger(delayMillis) ||
      delayMillis < 0 ||
      delayMillis > 5000
    ) {
      throw new Error("Policy delay must be between 0 and 5000 ms");
    }
    if (response.destroyed || response.writableEnded) return;
    if (delayMillis === 0) {
      deliver();
      return;
    }
    if (this.waiting.size >= this.capacity) {
      response.writeHead(503).end();
      return;
    }
    const cancel = () => {
      clearTimeout(timer);
      this.waiting.delete(response);
      response.removeListener("close", cancel);
    };
    const timer = setTimeout(() => {
      cancel();
      if (!response.destroyed && !response.writableEnded) deliver();
    }, delayMillis);
    this.waiting.set(response, cancel);
    response.once("close", cancel);
  }
  close(): void {
    for (const cancel of this.waiting.values()) cancel();
  }
}
