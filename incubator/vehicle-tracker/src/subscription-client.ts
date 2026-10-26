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
  onConnection(
    state: "disconnected" | "connecting" | "connected" | "error",
    reason?: string,
  ): void;
  onSubscription(
    viewId: string,
    entityId: string,
    state: "pending" | "subscribed" | "unsubscribed",
  ): void;
  onView(viewId: string, entityId: string, data: unknown): void;
}

/** Owns one socket, its generations, subscriptions and pending acknowledgement. */
export function createSubscriptionClient(
  dataPath: string,
  report: (event: Record<string, unknown>) => void,
  fail: (reason: string) => void,
  binding: ClientBinding,
) {
  let socket: WebSocket | undefined;
  let generation = 0;
  let observationIndex = 0;
  let deliberateClose = false;
  let failure: string | undefined;

  const markFailure = (reason: string, notify = true) => {
    if (failure) return;

    failure = reason;
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

    if (notify) fail(reason);
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
    if (failure) throw new Error(failure);
    if (command.action === "connect") {
      if (socket?.readyState === WebSocket.OPEN) return generation;

      const current = new WebSocket(`ws://${location.host}${dataPath}`);

      socket = current;
      generation++;
      deliberateClose = false;
      subscriptions.clear();
      binding.onConnection("connecting");
      current.addEventListener("message", (event) => {
        if (socket !== current || failure) return;

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
            )
              throw new Error("Unexpected subscription response.");

            if (message.type === "subscribed") subscriptions.add(pair);
            else subscriptions.delete(pair);

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
            binding.onView(message.viewId, message.entityId, message.data);
            observe("view-update", {
              viewId: message.viewId,
              entityId: message.entityId,
              data: message.data,
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
        if (socket !== current) return;

        subscriptions.clear();
        acknowledgement?.reject(
          new Error("Connection closed before acknowledgement."),
        );
        acknowledgement = undefined;

        if (!failure) {
          if (deliberateClose) binding.onConnection("disconnected");
          else markFailure(binding.connectionLostReason);
        }

        observe("closed");
      });
      await new Promise<void>((resolve, reject) => {
        current.addEventListener(
          "open",
          () => {
            if (socket !== current || failure) return;

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
            if (socket !== current) return;

            const reason = "Could not connect to ZooGlass.";

            markFailure(reason);
            reject(new Error(reason));
          },
          { once: true },
        );
      });
    } else if (command.action === "disconnect") {
      deliberateClose = true;

      if (socket && socket.readyState !== WebSocket.CLOSED) {
        const current = socket;
        await new Promise<void>((resolve) => {
          current.addEventListener("close", () => resolve(), { once: true });
          current.close();
        });
      }
    } else {
      if (socket?.readyState !== WebSocket.OPEN)
        throw new Error("ZooGlass socket is not open.");

      binding.validateSubscription(command.viewId, command.entityId);

      const { viewId, entityId } = command;

      if (!viewId || !entityId)
        throw new Error("Missing subscription identity.");

      if (command.action === "subscribe")
        binding.onSubscription(viewId, entityId, "pending");

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
      socket?.close();
    },
  };
}
