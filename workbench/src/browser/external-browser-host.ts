import { WebSocket, WebSocketServer } from "ws";
import { startBrowserHttpServer } from "./browser-http-server.js";
import { createBrowserRun, type BrowserRun } from "./browser-run.js";
import { createViewerLeases, type ViewerLease } from "./viewer-leases.js";
import type {
  BrowserApplication,
  BrowserControlAction,
} from "./browser-host.js";

interface ExternalHostOptions {
  application: BrowserApplication;
  bindAddress: string;
  onReady(run: BrowserRun): Promise<void>;
  onControl(
    action: BrowserControlAction,
    target: string | undefined,
  ): Promise<void>;
  onControllerLost(): void;
  readinessTimeoutMs?: number;
}
interface ViewerConnection {
  lease: ViewerLease;
  socket: WebSocket;
  run?: BrowserRun;
  ready: boolean;
  epoch?: number;
  alive?: boolean;
  registered?: boolean;
}

/** Paired external viewers share playback, never a data connection or receipt buffer. */
export async function startExternalBrowserHost(options: ExternalHostOptions) {
  const http = await startBrowserHttpServer(
    options.application,
    options.bindAddress,
  );
  const leases = createViewerLeases();
  const viewers = new Map<string, ViewerConnection>();
  const server = new WebSocketServer({ noServer: true, maxPayload: 16_384 });
  const lifetime = new AbortController();
  let baseUrl: string | undefined;
  let epoch = 0;
  let replacing = false;
  let closing: Promise<void> | undefined;
  let latestState: unknown;
  let commands = Promise.resolve();
  let pendingCommands = 0;
  const tasks = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>) => {
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => {});
    return task;
  };
  const roles = () => {
    for (const viewer of viewers.values())
      viewer.run?.publish({
        kind: "viewer-session",
        viewerId: viewer.lease.id,
        controller: leases.isController(viewer.lease.id),
        viewers: leases.list(),
      });
  };
  function detach(viewer: ViewerConnection) {
    if (viewers.get(viewer.lease.id) !== viewer) return;
    viewers.delete(viewer.lease.id);
    leases.disconnect(viewer.lease.id);
    viewer.ready = false;
    if (viewer.run) track(viewer.run.close());
    viewer.socket.terminate();
    if (leases.isController(viewer.lease.id) && !closing)
      options.onControllerLost();
    roles();
  }
  function command(
    viewer: ViewerConnection,
    run: BrowserRun,
    action: BrowserControlAction,
    target?: string,
  ) {
    // Admission and execution checks prevent queued work surviving role transfer or Reset.
    const checkAuthority = leases.authority(viewer.lease.id);
    if (pendingCommands >= 16)
      throw new Error("Control command queue is full.");
    pendingCommands++;
    const admitted = epoch;
    const targetRun = target ? viewers.get(target)?.run : undefined;
    const result = commands.then(async () => {
      checkAuthority();
      if (
        closing ||
        replacing ||
        (target && viewers.get(target)?.run !== targetRun) ||
        admitted !== epoch ||
        viewers.get(viewer.lease.id) !== viewer ||
        viewer.run !== run ||
        !viewer.ready
      )
        throw new Error("This viewer or run has been replaced.");
      await options.onControl(action, target);
    });
    commands = result
      .finally(() => {
        pendingCommands--;
      })
      .catch(() => {});
    return result;
  }
  async function bind(viewer: ViewerConnection) {
    const boundEpoch = epoch;
    viewer.ready = false;
    await viewer.run?.close();
    if (
      !baseUrl ||
      closing ||
      boundEpoch !== epoch ||
      viewers.get(viewer.lease.id) !== viewer
    )
      return;
    const run = createBrowserRun(baseUrl, {
      clientId: viewer.lease.id,
      recordReceipts: false,
      send(message) {
        if (viewer.run !== run || viewer.socket.readyState !== WebSocket.OPEN)
          return false;
        viewer.socket.send(JSON.stringify(message));
        return true;
      },
      onControl: async (action, _runId, target) =>
        command(viewer, run, action, target),
    });
    viewer.run = run;
    viewer.epoch = boundEpoch;
    const registered = !viewer.registered;
    viewer.registered = true;
    run.announce(
      registered ? "registered" : "run-changed",
      registered
        ? {
            lease: viewer.lease.id,
            capability: viewer.lease.capability,
          }
        : {},
    );
    try {
      await run.waitForReady(
        lifetime.signal,
        options.readinessTimeoutMs ?? 15_000,
      );
      await options.onReady(run);
      if (boundEpoch !== epoch || viewer.run !== run) return;
      viewer.ready = true;
      if (latestState) run.publish(latestState);
      roles();
    } catch {
      if (boundEpoch === epoch && viewer.run === run) detach(viewer);
    }
  }
  server.on("connection", (socket) => {
    let viewer: ViewerConnection | undefined;
    const deadline = setTimeout(() => socket.terminate(), 5_000);
    socket.on("pong", () => {
      if (viewer) viewer.alive = true;
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      clearTimeout(deadline);
      if (viewer) detach(viewer);
    });
    socket.on("message", (data, binary) => {
      try {
        if (binary) throw new Error();
        const message = JSON.parse(data.toString());
        if (!message || typeof message !== "object") throw new Error();
        if (!viewer) {
          if (
            message.type !== "register" ||
            message.protocolVersion !== 1 ||
            !baseUrl ||
            replacing
          )
            throw new Error();
          const lease = leases.claim(message);
          viewer = { lease, socket, ready: false, alive: true };
          viewers.set(lease.id, viewer);
          clearTimeout(deadline);
          track(bind(viewer));
        } else viewer.run?.receive(message);
      } catch {
        socket.close(1008, "Invalid viewer registration or message.");
      }
    });
  });
  http.server.on("upgrade", (request, socket, head) => {
    if (closing || !http.accepts(request)) {
      socket.end("HTTP/1.1 403 Rejected\r\nConnection: close\r\n\r\n");
      return;
    }
    if (
      request.url === "/control" &&
      baseUrl &&
      !replacing &&
      server.clients.size < 16
    ) {
      server.handleUpgrade(request, socket, head, (client) =>
        server.emit("connection", client),
      );
      return;
    }
    const viewer = [...viewers.values()].find(
      (item) =>
        item.epoch === epoch &&
        item.run?.ready &&
        item.run.dataPath === request.url,
    );
    if (viewer) viewer.run!.upgrade(request, socket, head);
    else socket.end("HTTP/1.1 403 Rejected\r\nConnection: close\r\n\r\n");
  });
  http.server.on("error", () => {
    lifetime.abort(new Error("External browser host failed."));
  });
  const heartbeat = setInterval(() => {
    for (const viewer of viewers.values()) {
      if (!viewer.alive) detach(viewer);
      else {
        viewer.alive = false;
        viewer.socket.ping();
      }
    }
  }, 15_000);
  return {
    origin: http.origin,
    signal: lifetime.signal,
    pair(name: string, controller = false) {
      if (closing) throw new Error("Host closed.");
      const invitation = leases.issue(name, controller);
      roles();
      return {
        id: invitation.id,
        url: `${http.origin}/#pair=${invitation.token}`,
      };
    },
    list: leases.list,
    transfer(id: string) {
      leases.transfer(id);
      options.onControllerLost();
      roles();
    },
    revoke(id: string) {
      const viewer = viewers.get(id);
      if (viewer) detach(viewer);
      else if (leases.isController(id)) options.onControllerLost();
      leases.revoke(id);
      roles();
    },
    viewer(id: string) {
      const viewer = viewers.get(id);
      if (!viewer?.ready || !viewer.run || viewer.run.signal.aborted)
        throw new Error("Target viewer is not ready.");
      return viewer.run;
    },
    async retireRun() {
      epoch++;
      baseUrl = undefined;
      latestState = undefined;
      await Promise.all(
        [...viewers.values()].map(async (viewer) => {
          viewer.ready = false;
          await viewer.run?.close();
        }),
      );
    },
    async replaceRun(url: string) {
      if (closing || replacing)
        throw new Error("Host closed or replacement already in progress.");
      replacing = true;
      epoch++;
      baseUrl = url;
      try {
        await Promise.all(
          [...viewers.values()].map((viewer) => track(bind(viewer))),
        );
      } finally {
        replacing = false;
      }
    },
    broadcast(event: unknown) {
      for (const viewer of viewers.values()) viewer.run?.publish(event);
    },
    publish(state: unknown) {
      latestState = state;
      for (const viewer of viewers.values()) viewer.run?.publish(state);
    },
    close(): Promise<void> {
      return (closing ??= (async () => {
        clearInterval(heartbeat);
        lifetime.abort(new Error("External host closed."));
        for (const viewer of [...viewers.values()]) detach(viewer);
        for (const socket of server.clients) socket.terminate();
        await Promise.allSettled([...tasks]);
        leases.clear();
        await Promise.all([
          http.close(),
          new Promise<void>((resolve) => server.close(() => resolve())),
        ]);
      })());
    },
  };
}
export type ExternalBrowserHost = Awaited<
  ReturnType<typeof startExternalBrowserHost>
>;
