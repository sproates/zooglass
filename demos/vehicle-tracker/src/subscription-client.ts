/** Full runtime snapshot. Consumers replace state, including status-only updates. */
export interface ViewSnapshot {
  viewId: string;
  entityId: string;
  version: number;
  data: Record<string, unknown>;
  provenance: Record<
    string,
    { sourceId: string; epoch: string; sourceEntityId: string }
  >;
  publicationSequences: Record<string, number[]>;
  status: {
    publication: string;
    missingFields: string[];
    missingRequiredFields: string[];
    fields: Record<
      string,
      { freshness: string; receivedAtMillis: number | null; inputs: string[] }
    >;
    inputs: Record<
      string,
      {
        state: string;
        mode: string;
        epoch: string;
        sourceEntityId: string | null;
        observedThrough: number | null;
        watermarkThrough: number | null;
        completeThrough: number | null;
        completeness: string;
        missingRanges: { from: number; through: number; status: string }[];
      }
    >;
  };
}

interface PendingAcknowledgement {
  action: string;
  viewId: string;
  entityId: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

export type Command = {
  action: "connect" | "disconnect" | "subscribe" | "unsubscribe";
  viewId?: string;
  entityId?: string;
};

/** Application policy and presentation are supplied by the caller. */
export interface ClientBinding {
  validateSubscription(
    viewId: string | undefined,
    entityId: string | undefined,
  ): void;
  connectionLostReason: string;
  /** Protected clients discard all rendered and retained data on any loss. */
  clearProtectedData?(): void;
  onConnection(
    state:
      "disconnected" | "connecting" | "connected" | "reconnecting" | "error",
    reason?: string,
  ): void;
  onSubscription(
    viewId: string,
    entityId: string,
    state: "pending" | "subscribed" | "unsubscribed",
  ): void;
  /** Compatibility callback for existing value-only vehicle bindings. */
  onView?(viewId: string, entityId: string, data: unknown): void;
  onSnapshot?(snapshot: ViewSnapshot): void;
}

/** Owns one socket, its generations, subscriptions and pending acknowledgement. */
export function createSubscriptionClient(
  dataPath: string,
  report: (event: Record<string, unknown>) => void,
  fail: (reason: string, transport?: boolean) => void,
  binding: ClientBinding,
) {
  function clearProtectedData() {
    try {
      binding.clearProtectedData?.();
    } catch {
      // A broken renderer must not prevent connection cleanup and cancellation.
    }
  }

  let socket: WebSocket | undefined;
  let generation = 0;
  let observationIndex = 0;
  let deliberateClose = false;
  let accepting = false;
  let failure: string | undefined;

  const markFailure = (reason: string, notify = true, transport = false) => {
    if (failure) {
      return;
    }

    failure = reason;
    accepting = false;
    clearProtectedData();
    deliberateClose = true;
    acknowledgement?.reject(new Error(reason));
    acknowledgement = undefined;

    // Rendering an error must not prevent cleanup or hide the original failure.
    try {
      binding.onConnection("error", reason);
    } catch {
      // The client is already failed; continue closing and notifying Workbench.
    }

    socket?.close();

    if (notify) {
      fail(reason, transport);
    }
  };

  const subscriptions = new Set<string>();

  const key = (viewId: string, entityId: string) =>
    JSON.stringify([viewId, entityId]);

  let acknowledgement: PendingAcknowledgement | undefined;

  const observe = (event: string, detail: Record<string, unknown> = {}) =>
    report({
      type: "observation",
      event,
      connectionGeneration: generation,
      observationIndex: ++observationIndex,
      ...detail,
    });

  async function execute(command: Command) {
    if (failure && command.action !== "disconnect") {
      throw new Error(failure);
    }
    if (command.action === "connect") {
      if (socket?.readyState === WebSocket.OPEN) {
        return generation;
      }

      const url = new URL(
        dataPath,
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`,
      );
      const current = new WebSocket(url.href);

      socket = current;
      generation++;
      deliberateClose = false;
      accepting = true;
      subscriptions.clear();
      binding.onConnection("connecting");
      current.addEventListener("message", (event) => {
        if (socket !== current || failure || !accepting) {
          return;
        }

        try {
          const message = JSON.parse(event.data);
          const pair = key(message.viewId, message.entityId);

          if (
            message.type === "subscribed" ||
            message.type === "unsubscribed"
          ) {
            const waiting = acknowledgement;

            if (
              !waiting ||
              message.type !== `${waiting.action}d` ||
              message.viewId !== waiting.viewId ||
              message.entityId !== waiting.entityId
            ) {
              throw new Error("Unexpected subscription response.");
            }

            if (message.type === "subscribed") {
              subscriptions.add(pair);
            } else {
              subscriptions.delete(pair);
            }

            binding.onSubscription(
              message.viewId,
              message.entityId,
              message.type,
            );
            observe(message.type, {
              viewId: message.viewId,
              entityId: message.entityId,
            });
            acknowledgement = undefined;
            waiting.resolve();
          } else if (
            message.type === "view-update" &&
            subscriptions.has(pair)
          ) {
            const snapshot: ViewSnapshot = {
              viewId: message.viewId,
              entityId: message.entityId,
              version: message.version,
              data: message.data,
              status: message.status,
              provenance: message.provenance,
              publicationSequences: message.publicationSequences,
            };
            binding.onSnapshot?.(snapshot);
            binding.onView?.(message.viewId, message.entityId, message.data);
            observe("view-update", {
              ...snapshot,
            });
          } else {
            throw new Error("Unexpected ZooGlass message.");
          }
        } catch (error) {
          markFailure(
            error instanceof Error
              ? error.message
              : "Invalid ZooGlass response.",
          );
        }
      });
      current.addEventListener("close", () => {
        if (socket !== current) {
          return;
        }

        accepting = false;
        clearProtectedData();
        subscriptions.clear();
        acknowledgement?.reject(
          new Error("Connection closed before acknowledgement."),
        );
        acknowledgement = undefined;

        if (!failure) {
          if (deliberateClose) {
            binding.onConnection("disconnected");
          } else {
            markFailure(binding.connectionLostReason, true, true);
          }
        }

        observe("closed");
      });
      await new Promise<void>((resolve, reject) => {
        // Closing a handshake may emit an error after accepting has been disabled.
        // Settle this socket's own operation even when its callbacks are obsolete.
        current.addEventListener(
          "close",
          () => reject(new Error("Connection closed before opening.")),
          { once: true },
        );
        current.addEventListener(
          "open",
          () => {
            if (socket !== current || failure || !accepting) {
              return;
            }

            try {
              binding.onConnection("connected");
              observe("opened");
              resolve();
            } catch (error) {
              const reason =
                error instanceof Error
                  ? error.message
                  : "Could not present connection state.";
              reject(new Error(reason));
              markFailure(reason);
            }
          },
          { once: true },
        );
        current.addEventListener(
          "error",
          () => {
            if (socket !== current || !accepting) {
              return;
            }

            const reason = "Could not connect to ZooGlass.";

            markFailure(reason, true, true);
            reject(new Error(reason));
          },
          { once: true },
        );
      });
    } else if (command.action === "disconnect") {
      deliberateClose = true;
      accepting = false;
      clearProtectedData();

      if (socket && socket.readyState !== WebSocket.CLOSED) {
        const current = socket;
        await new Promise<void>((resolve) => {
          current.addEventListener("close", () => resolve(), { once: true });
          current.close();
        });
      }
    } else {
      if (socket?.readyState !== WebSocket.OPEN) {
        throw new Error("ZooGlass socket is not open.");
      }

      binding.validateSubscription(command.viewId, command.entityId);

      const { viewId, entityId } = command;

      if (!viewId || !entityId) {
        throw new Error("Missing subscription identity.");
      }

      if (command.action === "subscribe") {
        binding.onSubscription(viewId, entityId, "pending");
      }

      await new Promise<void>((resolve, reject) => {
        acknowledgement = {
          action: command.action,
          viewId,
          entityId,
          resolve,
          reject,
        };
        socket!.send(
          JSON.stringify({ action: command.action, viewId, entityId }),
        );
      });
    }

    return generation;
  }

  return {
    execute,
    fail(reason: string) {
      markFailure(reason, false);
    },
    close() {
      deliberateClose = true;
      accepting = false;
      clearProtectedData();
      socket?.close();
    },
  };
}
