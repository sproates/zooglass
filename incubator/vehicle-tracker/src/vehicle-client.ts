import { receiveView, setConnection, subscriptionState } from "./view.js";
export type Command = {
  action: "connect" | "disconnect" | "subscribe" | "unsubscribe";
  viewId?: string;
  entityId?: string;
};
export function createVehicleClient(
  dataPath: string,
  report: (event: Record<string, unknown>) => void,
  fail: (reason: string) => void,
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
    setConnection("error", reason);
    acknowledgement?.reject(new Error(reason));
    acknowledgement = undefined;
    socket?.close();
    if (notify) fail(reason);
  };
  const subscriptions = new Set<string>();
  const key = (viewId: string, entityId: string) =>
    JSON.stringify([viewId, entityId]);
  let acknowledgement:
    | {
        action: string;
        viewId: string;
        entityId: string;
        resolve: () => void;
        reject: (error: Error) => void;
      }
    | undefined;
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
      setConnection("connecting");
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
            acknowledgement = undefined;
            subscriptionState(message.viewId, message.type);
            observe(message.type, {
              viewId: message.viewId,
              entityId: message.entityId,
            });
            waiting.resolve();
          } else if (
            message.type === "view-update" &&
            subscriptions.has(pair)
          ) {
            receiveView(message.viewId, message.entityId, message.data);
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
          if (deliberateClose) setConnection("disconnected");
          else
            markFailure(
              "Connection lost. Stop and restart the demo to try again.",
            );
        }
        observe("closed");
      });
      await new Promise<void>((resolve, reject) => {
        current.addEventListener(
          "open",
          () => {
            if (socket !== current || failure) return;
            setConnection("connected");
            observe("opened");
            resolve();
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
      if (
        !command.viewId ||
        command.entityId !== "car-17" ||
        !["live-map", "trip-history"].includes(command.viewId)
      )
        throw new Error("Unknown vehicle view.");
      const { viewId, entityId } = command;
      if (command.action === "subscribe") subscriptionState(viewId, "pending");
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
