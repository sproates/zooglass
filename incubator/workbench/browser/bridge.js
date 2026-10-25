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
  const step = document.querySelector("#step");
  const play = document.querySelector("#play");
  const pause = document.querySelector("#pause");
  const disconnect = document.querySelector("#disconnect");
  const reconnect = document.querySelector("#reconnect");
  const reset = document.querySelector("#reset");
  const controlError = document.querySelector("#control-error");
  for (const [button, action] of [
    [step, "step"],
    [play, "play"],
    [pause, "pause"],
    [reset, "reset"],
    [disconnect, "disconnect"],
    [reconnect, "reconnect"],
  ]) {
    button.addEventListener("click", () => {
      controlError.textContent = "";
      button.disabled = true;
      send({ type: "control-request", action });
    });
  }
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
      if (message.type === "run-state") {
        document.querySelector("#workbench-controls").hidden = false;
        const state = message.state;
        if (state.phase === "failed") client?.fail(state.detail);
        step.disabled = state.phase !== "ready" || state.playing;
        play.disabled = state.phase !== "ready" || state.playing;
        pause.disabled = !state.playing;
        disconnect.disabled = reconnect.disabled =
          state.playing || !["ready", "complete"].includes(state.phase);
        document.querySelector("#run-mode").textContent = state.exploratory
          ? `Exploratory · ${state.interventions} manual intervention(s) · Last: ${state.lastIntervention} · ${state.skippedChecks} client checks skipped. Reset for a scripted run.`
          : "Scripted run";
        reset.disabled = ["starting", "resetting", "closed"].includes(
          state.phase,
        );
        document.querySelector("#run-progress").textContent =
          `${state.completed}/${state.total} ${state.exploratory ? "steps executed" : "steps checked"} · ${state.detail}`;
        controlError.textContent = "";
        return;
      }
      if (message.type === "control-rejected") {
        controlError.textContent = message.reason;
        return;
      }
      if (message.type === "run-failed" && client) {
        client.fail(message.reason);
        status.textContent = "Workbench run failed · playback stopped";
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
    step.disabled = true;
    reset.disabled = true;
    play.disabled = true;
    pause.disabled = true;
    disconnect.disabled = true;
    reconnect.disabled = true;
    controlError.textContent =
      "Control connection lost. Type reset in the terminal to start again.";
    client?.fail("Workbench control connection lost.");
    client?.close();
    status.textContent = "Workbench disconnected · playback stopped";
  });
  control.addEventListener("error", () => {
    status.textContent = "Could not connect to Workbench.";
  });
}
