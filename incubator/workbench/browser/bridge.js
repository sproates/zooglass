/** Control protocol only. The application supplies its client and presentation hooks. */
export function startBrowserBridge({
  createClient,
  onStatus = () => {},
  onRunState = () => {},
  onRunChanged = () => {},
  onControlRejected = () => {},
}) {
  const registration = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", "/");
  let runId = registration.get("runId");
  const clientId = registration.get("clientId");
  if (!runId || !clientId || !registration.get("token")) {
    onStatus("unregistered");
    return { requestControl() {} };
  }
  const control = new WebSocket(`ws://${location.host}/control`);
  const send = (message) => {
    if (control.readyState === WebSocket.OPEN)
      control.send(JSON.stringify({ ...message, runId, clientId }));
  };
  let client;
  let binding;
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
      if (message.clientId !== clientId) return;
      if (
        message.type === "run-changed" ||
        (message.type === "registered" && !client)
      ) {
        if (
          typeof message.runId !== "string" ||
          typeof message.dataPath !== "string"
        )
          throw new Error("Invalid run binding.");
        client?.close();
        runId = message.runId;
        const next = { runId, busy: false, completed: new Map() };
        binding = next;
        // Async work from an old client cannot be relabelled as the new run.
        const report = (value) => {
          if (binding === next) send(value);
        };
        onRunChanged();
        client = createClient(message.dataPath, report, (reason) =>
          report({ type: "fatal", reason }),
        );
        send({ type: "ready" });
        onStatus("ready");
        return;
      }
      if (message.runId !== runId) return;
      if (message.type === "run-state") {
        onRunState(message.state, client);
        return;
      }
      if (message.type === "control-rejected") {
        onControlRejected(message.reason);
        return;
      }
      if (message.type === "run-failed" && client) {
        client.fail(message.reason);
        onStatus("failed");
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
      const current = binding;
      const { completed } = current;
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
      if (current.busy || completed.size >= 256)
        throw new Error(
          "Browser command limit reached or action already running.",
        );
      current.busy = true;
      try {
        const generation = await client.execute(message);
        if (binding !== current) return;
        const result = {
          type: "completed",
          commandId: message.commandId,
          connectionGeneration: generation,
        };
        completed.set(message.commandId, { signature, result });
        send(result);
      } catch (error) {
        if (binding !== current) return;
        send({
          type: "failed",
          commandId: message.commandId,
          reason: error.message,
        });
      } finally {
        current.busy = false;
      }
    } catch (error) {
      send({ type: "fatal", reason: error.message });
    }
  });
  control.addEventListener("close", () => {
    client?.fail("Workbench control connection lost.");
    client?.close();
    onStatus("closed");
  });
  control.addEventListener("error", () => {
    onStatus("error");
  });
  return {
    requestControl(action) {
      send({ type: "control-request", action });
    },
  };
}
