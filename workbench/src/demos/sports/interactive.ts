import { WebSocket, WebSocketServer } from "ws";
import type { ControlExchange } from "../../execution/control-request.js";
import { startBrowserHttpServer } from "../../browser/browser-http-server.js";
import { createBrowserDataRoute } from "../../browser/browser-data-route.js";
import { createCheckpointController } from "../../control/prepared-checkpoints.js";
import type { DemoState } from "../../control/demo-controller.js";
import type { ZooGlassSession } from "../../service/zooglass-session.js";
import { openSportsRun } from "./run.js";
import { sportsApplication } from "./application.js";
import { type SportsStep } from "./timeline.js";
import { describeSportsStep } from "./notices.js";
import { sportsCheckpoints } from "./checkpoints.js";

interface InteractiveOptions {
  bindAddress?: string;
  signal?: AbortSignal;
  /** Accelerate playback spacing in verification; freshness still uses the real timer. */
  delayBefore?: number;
  onService?: (service: ZooGlassSession) => void;
  onStep?: (step: SportsStep, signal: AbortSignal) => void | Promise<void>;
  exchange?: ControlExchange;
}

/** Stable page/control host; Reset retires the entire data route, service and store. */
export async function startInteractiveSports(options: InteractiveOptions = {}) {
  options.signal?.throwIfAborted();
  const application = await sportsApplication(true);
  const assets = new Map(application.assets);
  const host = await startBrowserHttpServer(
    { ...application, assets },
    options.bindAddress,
  );
  const control = new WebSocketServer({ noServer: true, maxPayload: 65536 });
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
  const notices: { text: string }[] = [];
  function activity() {
    assets.set("/activity.json", [
      "application/json",
      Buffer.from(
        JSON.stringify({ state: lastState?.phase ?? "starting", notices }),
      ),
    ]);
  }
  function message(state = lastState) {
    return JSON.stringify({
      kind: "state",
      generation,
      ...state,
      checkpoint:
        state?.phase === "stepping"
          ? sportsCheckpoints[state.completed]?.label
          : undefined,
      next:
        sportsCheckpoints[state?.completed ?? 0]?.label ??
        "All checkpoints verified.",
    });
  }
  function publish(state: DemoState) {
    if (state.phase === "resetting") generation++;
    lastState = state;
    activity();
    const data = message(state);
    for (const socket of control.clients) {
      if (socket.bufferedAmount > 65536) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) socket.send(data);
    }
  }
  const controller = createCheckpointController(
    sportsCheckpoints,
    async (signal) => {
      notices.length = 0;
      activity();
      return openSportsRun({
        signal,
        route: (next) => {
          route = next;
        },
        notice: (step) => {
          notices.push({ text: describeSportsStep(step) });
          if (notices.length > 20) notices.shift();
          activity();
        },
        onStep: options.onStep,
        exchange: options.exchange,
        onService: (service) => {
          baseUrl = service.baseUrl;
          options.onService?.(service);
        },
      });
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
        if (raw.toString().length > 1024) {
          socket.close(1009, "Control command too large");
          return;
        }
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
