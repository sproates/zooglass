import { createVehicleClient } from "/vehicle-client.js";
const registration = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, "", "/");
const runId = registration.get("runId");
const clientId = registration.get("clientId");
const status = document.querySelector("#status");
if (!runId || !clientId || !registration.get("token")) {
  status.textContent = "Open this demo through Workbench.";
} else {
  const control = new WebSocket(`ws://${location.host}/control`);
  const send = (message) => {
    if (control.readyState === WebSocket.OPEN)
      control.send(JSON.stringify({ ...message, runId, clientId }));
  };
  let client;
  let busy = false;
  const completed = new Map();
  control.addEventListener("open", () => {
    send({
      type: "register",
      protocolVersion: 1,
      token: registration.get("token"),
    });
    registration.delete("token");
  });
  control.addEventListener("message", async (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.runId !== runId || message.clientId !== clientId) return;
      if (message.type === "registered" && !client) {
        document.body.dataset.dataPath = message.dataPath;
        client = createVehicleClient(message.dataPath, send, (reason) =>
          send({ type: "fatal", reason }),
        );
        send({ type: "ready" });
        status.textContent = "Connected to Workbench";
        return;
      }
      if (
        message.type !== "command" ||
        !client ||
        typeof message.commandId !== "string" ||
        !["connect", "disconnect", "subscribe", "unsubscribe"].includes(
          message.action,
        )
      )
        throw new Error("Invalid control command.");
      const signature = JSON.stringify([
        message.action,
        message.viewId,
        message.entityId,
      ]);
      const cached = completed.get(message.commandId);
      if (cached) {
        if (cached.signature !== signature)
          throw new Error("Command ID reused with different arguments.");
        send(cached.result);
        return;
      }
      if (busy || completed.size >= 256)
        throw new Error(
          "Browser command limit reached or action already running.",
        );
      busy = true;
      try {
        const generation = await client.execute(message);
        const result = {
          type: "completed",
          commandId: message.commandId,
          connectionGeneration: generation,
        };
        completed.set(message.commandId, { signature, result });
        send(result);
      } catch (error) {
        send({
          type: "failed",
          commandId: message.commandId,
          reason: error.message,
        });
      } finally {
        busy = false;
      }
    } catch (error) {
      send({ type: "fatal", reason: error.message });
    }
  });
  control.addEventListener("close", () => {
    client?.close();
    status.textContent = "Workbench disconnected.";
  });
  control.addEventListener("error", () => {
    status.textContent = "Could not connect to Workbench.";
  });
}
