import { WebSocket, WebSocketServer } from "ws";
import { startBrowserHttpServer } from "../../browser/browser-http-server.js";
import { createBrowserDataRoute } from "../../browser/browser-data-route.js";
import { createCheckpointController } from "../../control/prepared-checkpoints.js";
import type { DemoState } from "../../control/demo-controller.js";
import { startZooGlassSession } from "../../service/zooglass-session.js";
import { orderApplication } from "./application.js";
import { orderConfiguration } from "./configuration.js";
import { openOrderSources } from "./source-session.js";
import { orderStep, type OrderStep } from "./timeline.js";
import { describeOrderStep } from "./notices.js";
import { orderCheckpoints } from "./checkpoints.js";

interface InteractiveOptions {
  bindAddress?: string;
  signal?: AbortSignal;
  /** Accelerate playback spacing in verification; freshness still uses the real timer. */
  delayBefore?: number;
  onStep?: (step: OrderStep, signal: AbortSignal) => void | Promise<void>;
}

/** Stable page/control host; Reset retires the entire data route, service and store. */
export async function startInteractiveOrders(options: InteractiveOptions = {}) {
  options.signal?.throwIfAborted();
  const application = await orderApplication(true);
  const assets = new Map(application.assets);
  const host = await startBrowserHttpServer(
    { ...application, assets },
    options.bindAddress,
  );
  const control = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  let route: ReturnType<typeof createBrowserDataRoute> | undefined;
  let baseUrl: string | undefined;
  let generation = 0;
  let closing: Promise<void> | undefined;
  let finish!: () => void;
  let failed!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    failed = reject;
  });
  void done.catch(() => {});
  let hostFailure: Error | undefined;
  let lastState: DemoState | undefined;
  const notices: { tick: number; text: string }[] = [];
  function activity() {
    assets.set("/activity.json", [
      "application/json",
      Buffer.from(JSON.stringify(notices)),
    ]);
  }
  function message(state = lastState) {
    return JSON.stringify({
      kind: "state",
      generation,
      ...state,
      checkpoint:
        state?.phase === "stepping"
          ? orderCheckpoints[state.completed]?.label
          : undefined,
      next:
        orderCheckpoints[state?.completed ?? 0]?.label ??
        "All checkpoints verified.",
    });
  }
  function publish(state: DemoState) {
    if (state.phase === "resetting") generation++;
    lastState = state;
    const data = message(state);
    for (const socket of control.clients) {
      if (socket.bufferedAmount > 65536) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) socket.send(data);
    }
  }
  const controller = createCheckpointController(
    orderCheckpoints,
    async (signal) => {
      const service = await startZooGlassSession({
        configuration: orderConfiguration(),
        signal,
      });
      baseUrl = service.baseUrl;
      let sources: Awaited<ReturnType<typeof openOrderSources>> | undefined;
      const data = createBrowserDataRoute(service.baseUrl, service.signal);
      let closed: Promise<void> | undefined;
      const close = () =>
        (closed ??= (async () => {
          if (route === data) route = undefined;
          try {
            await data.close();
          } finally {
            try {
              await sources?.close();
            } finally {
              await service.close();
            }
          }
        })());
      try {
        sources = await openOrderSources(service.baseUrl, service.signal);
        signal.throwIfAborted();
        route = data;
        notices.length = 0;
        activity();
        let tick = 0;
        const epoch = Date.now();
        return {
          signal: service.signal,
          baseUrl: service.baseUrl,
          close,
          async advance(through: number) {
            while (tick <= through) {
              service.signal.throwIfAborted();
              const step = orderStep(tick, epoch, 3000);
              await sources!.execute(step);
              notices.push({ tick, text: describeOrderStep(step) });
              if (notices.length > 20) notices.shift();
              activity();
              await options.onStep?.(step, service.signal);
              tick++;
            }
          },
        };
      } catch (error) {
        await close();
        throw error;
      }
    },
    publish,
    options.delayBefore,
  );
  const actions = ["step", "play", "pause", "reset"] as const;
  type Action = (typeof actions)[number];
  control.on("connection", (socket) => {
    socket.on("error", () => socket.terminate());
    socket.send(message());
    let pending = 0;
    socket.on("message", (raw, binary) => {
      if (pending >= 2) {
        socket.close(1008, "Too many pending commands");
        return;
      }
      pending++;
      void (async () => {
        const request = binary ? undefined : JSON.parse(raw.toString());
        if (
          !request ||
          request.generation !== generation ||
          !actions.includes(request.action)
        )
          throw new Error(
            "This command is invalid or belongs to a replaced run.",
          );
        await controller[request.action as Action]();
      })()
        .catch((error: unknown) => {
          if (socket.readyState === WebSocket.OPEN)
            socket.send(
              JSON.stringify({
                kind: "error",
                detail: error instanceof Error ? error.message : String(error),
              }),
            );
        })
        .finally(() => {
          pending--;
        });
    });
  });
  host.server.on("upgrade", (request, socket, head) => {
    if (!host.accepts(request) || closing) {
      socket.destroy();
      return;
    }
    if (request.url === "/controls" && control.clients.size < 16) {
      control.handleUpgrade(request, socket, head, (ws) =>
        control.emit("connection", ws),
      );
    } else if (request.url === "/views/live" && route)
      route.upgrade(request, socket, head);
    else socket.end("HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n");
  });
  function close() {
    if (closing) return closing;
    closing = (async () => {
      options.signal?.removeEventListener("abort", abort);
      try {
        await controller.close();
      } finally {
        for (const socket of control.clients) socket.terminate();
        try {
          await new Promise<void>((resolve) => control.close(() => resolve()));
        } finally {
          await host.close();
        }
      }
    })();
    void closing.then(() => {
      if (hostFailure) failed(hostFailure);
      else finish();
    }, failed);
    return closing;
  }
  const abort = () => {
    void close().catch(() => {});
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  host.server.on("error", (error) => {
    hostFailure = error;
    abort();
  });
  try {
    options.signal?.throwIfAborted();
    await controller.reset();
    return {
      origin: host.origin,
      done,
      close,
      command: (action: Action) => controller[action](),
      get state() {
        return controller.state;
      },
      get baseUrl() {
        return baseUrl!;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
