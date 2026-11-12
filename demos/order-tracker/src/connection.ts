import {
  createSubscriptionClient,
  type ViewSnapshot,
} from "../../vehicle-tracker/src/subscription-client.js";
import { orderIds, views } from "./model.js";

/** Automatic passive reconnection reuses the shared guarded subscription protocol. */
export function connectOrders(
  onSnapshot: (snapshot: ViewSnapshot) => void,
  onState: (state: string) => void,
  report: (event: Record<string, unknown>) => void = () => {},
) {
  let client: ReturnType<typeof createSubscriptionClient> | undefined;
  let generation = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const waiting = new Set<string>();
  function retire() {
    generation++;
    clearTimeout(retry);
    clearTimeout(deadline);
    const old = client;
    client = undefined;
    old?.close();
  }
  function connect() {
    retire();
    if (stopped || document.hidden) return;
    const current = generation;
    onState("connecting");
    waiting.clear();
    for (const view of views)
      for (const id of orderIds) waiting.add(`${view}/${id}`);
    const lost = (reason: string, transport = true) => {
      if (current !== generation) return;
      retire();
      onState(transport ? "disconnected" : `error: ${reason}`);
      if (transport && !stopped && !document.hidden)
        retry = setTimeout(connect, 1500);
    };
    const connection = createSubscriptionClient(
      "/views/live",
      (event) => {
        if (current === generation)
          report({ ...event, connectionGeneration: current });
      },
      lost,
      {
        connectionLostReason: "Order data connection interrupted.",
        validateSubscription(view, id) {
          if (
            !views.some((candidate) => candidate === view) ||
            !orderIds.includes(id ?? "")
          )
            throw new Error("Unknown Order subscription.");
        },
        onConnection() {},
        onSubscription() {},
        onSnapshot(snapshot) {
          if (current !== generation) return;
          onSnapshot(snapshot);
          waiting.delete(`${snapshot.viewId}/${snapshot.entityId}`);
          if (!waiting.size) {
            clearTimeout(deadline);
            onState("connected");
          }
        },
      },
    );
    client = connection;
    deadline = setTimeout(() => lost("Snapshot connection timed out."), 10000);
    void (async () => {
      await connection.execute({ action: "connect" });
      for (const viewId of views)
        for (const entityId of orderIds) {
          if (current !== generation) return;
          await connection.execute({ action: "subscribe", viewId, entityId });
        }
    })().catch((error) =>
      lost(error instanceof Error ? error.message : String(error)),
    );
  }
  function visibility() {
    if (document.hidden) {
      retire();
      onState("disconnected");
    } else connect();
  }
  const pageShow = (event: PageTransitionEvent) => {
    if (event.persisted && !stopped) connect();
  };
  const pageHide = (event: PageTransitionEvent) => {
    retire();
    onState("disconnected");
    if (!event.persisted) close();
  };
  function close() {
    stopped = true;
    retire();
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pageshow", pageShow);
    window.removeEventListener("pagehide", pageHide);
  }
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pageshow", pageShow);
  window.addEventListener("pagehide", pageHide);
  connect();
  return { close };
}
