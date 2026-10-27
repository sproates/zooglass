import { randomUUID } from "node:crypto";
import { createBrowserClientExecutor } from "./browser-client-executor.js";
import { createBrowserDataRoute } from "./browser-data-route.js";
import type {
  BrowserControlHandler,
  DataConnectionFault,
} from "./browser-host.js";

interface BrowserRunOptions {
  clientId: string;
  send: (message: Record<string, unknown>) => boolean;
  onControl?: BrowserControlHandler;
}

/** Run-scoped commands, receipts and data route; no ownership of the HTTP host. */
export function createBrowserRun(baseUrl: string, options: BrowserRunOptions) {
  const runId = randomUUID();
  const routeToken = randomUUID();
  const { clientId } = options;
  const controller = new AbortController();
  const data = createBrowserDataRoute(baseUrl, controller.signal);
  let ready = false;
  let closing: Promise<void> | undefined;
  const send = (message: Record<string, unknown>) =>
    options.send({ ...message, runId, clientId });

  const fail = (reason: string) => {
    if (controller.signal.aborted) return;
    if (ready) send({ type: "run-failed", reason });
    controller.abort(new Error(reason));
  };
  const client = createBrowserClientExecutor(
    clientId,
    controller.signal,
    (message) => {
      if (!ready || !send(message)) throw new Error("Browser is not ready.");
    },
    fail,
  );

  return {
    runId,
    clientId,
    dataPath: `/views/live?route=${routeToken}`,
    signal: controller.signal,
    executor: client.executor,
    observations: client.observations,
    fail,
    get ready() {
      return ready && !controller.signal.aborted;
    },
    announce(type: "registered" | "run-changed") {
      send({ type, dataPath: `/views/live?route=${routeToken}` });
    },
    receive(message: Record<string, unknown>) {
      // A delayed acknowledgement, receipt or control request belongs to its old run.
      if (message.runId !== runId || message.clientId !== clientId) return;
      if (message.type === "ready" && !ready && !controller.signal.aborted) {
        ready = true;
        return;
      }
      if (!ready) throw new Error("Browser is not ready.");
      if (message.type === "control-request" && options.onControl) {
        const action = message.action;
        if (
          ![
            "step",
            "reset",
            "play",
            "pause",
            "disconnect",
            "reconnect",
            "interrupt",
            "restore",
          ].includes(String(action))
        )
          throw new Error("Unknown browser control action.");
        void options
          .onControl(action as Parameters<BrowserControlHandler>[0], runId)
          .catch((error) =>
            send({
              type: "control-rejected",
              reason: error instanceof Error ? error.message : String(error),
            }),
          );
      } else if (!controller.signal.aborted) client.receive(message);
    },
    upgrade: data.upgrade,
    async controlDataConnection(fault: DataConnectionFault) {
      if (
        closing ||
        controller.signal.aborted ||
        fault.runId !== runId ||
        fault.clientId !== clientId
      )
        throw new Error("Data fault does not target an active run and client.");
      if (fault.action !== "break" && fault.action !== "restore")
        throw new Error("Unknown data fault action.");
      await data.setBlocked(fault.action === "break");
    },
    publish(state: unknown) {
      if (!closing) send({ type: "run-state", state });
    },
    async waitForReady(signal: AbortSignal, timeoutMs = 15_000) {
      const combined = AbortSignal.any([
        signal,
        controller.signal,
        AbortSignal.timeout(timeoutMs),
      ]);
      try {
        while (!ready) {
          combined.throwIfAborted();
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        combined.throwIfAborted();
      } catch (error) {
        fail("Browser readiness was interrupted or timed out.");
        throw error;
      }
    },
    close(): Promise<void> {
      return (closing ??= (async () => {
        controller.abort(new Error("Browser run retired."));
        await client.executor.close();
        await data.close();
      })());
    },
  };
}

export type BrowserRun = ReturnType<typeof createBrowserRun>;
