import { startBrowserBridge } from "/bridge.js";
import { createVehicleClient } from "/vehicle-client.js";

const status = document.querySelector("#status");
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
    bridge.requestControl(action);
  });
}

const bridge = startBrowserBridge({
  createClient(dataPath, report, fail) {
    document.body.dataset.dataPath = dataPath;
    return createVehicleClient(dataPath, report, fail);
  },
  onStatus(state) {
    const messages = {
      unregistered: "Open this demo through Workbench.",
      ready: "Connected to Workbench",
      failed: "Workbench run failed · playback stopped",
      closed: "Workbench disconnected · playback stopped",
      error: "Could not connect to Workbench.",
    };
    status.textContent = messages[state];
    if (state === "closed") {
      for (const button of [step, play, pause, reset, disconnect, reconnect])
        button.disabled = true;
      controlError.textContent =
        "Control connection lost. Type reset in the terminal to start again.";
    }
  },
  onRunState(state, client) {
    document.querySelector("#workbench-controls").hidden = false;
    if (state.phase === "failed") client?.fail(state.detail);
    step.disabled = state.phase !== "ready" || state.playing;
    play.disabled = state.phase !== "ready" || state.playing;
    pause.disabled = !state.playing;
    disconnect.disabled = reconnect.disabled =
      state.playing || !["ready", "complete"].includes(state.phase);
    document.querySelector("#run-mode").textContent = state.exploratory
      ? `Exploratory · ${state.interventions} manual intervention(s) · Last: ${state.lastIntervention} · ${state.skippedChecks} client checks skipped. Reset for a scripted run.`
      : "Scripted run";
    reset.disabled = ["starting", "resetting", "closed"].includes(state.phase);
    document.querySelector("#run-progress").textContent =
      `${state.completed}/${state.total} ${state.exploratory ? "steps executed" : "steps checked"} · ${state.detail}`;
    controlError.textContent = "";
  },
  onControlRejected(reason) {
    controlError.textContent = reason;
  },
});
