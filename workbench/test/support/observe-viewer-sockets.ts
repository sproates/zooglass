/** Preloaded only by the functional suite: observe real transport events,
 * independently of scheduled actions and the service's operational logging. */
const NativeWebSocket = globalThis.WebSocket;

globalThis.WebSocket = class extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    if (new URL(url).pathname !== "/views/live") return;
    this.addEventListener(
      "open",
      () => console.log("Observed viewer socket opened"),
      {
        once: true,
      },
    );
    this.addEventListener(
      "close",
      () => console.log("Observed viewer socket closed"),
      {
        once: true,
      },
    );
  }
};
