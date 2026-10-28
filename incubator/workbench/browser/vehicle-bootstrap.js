import { startBrowserBridge } from "/bridge.js";
import { createVehicleClient } from "/vehicle-client.js";
import {
  recordObservation,
  recordSourceSend,
  recordFault,
  resetActivity,
} from "/activity.js";

let createClient = createVehicleClient;
if (document.body.dataset.fleet === "true") {
  const { createFleetClient } = await import("/fleet/client.js");
  const response = await fetch("/fleet-manifest.json");
  if (!response.ok) throw new Error("Could not load fleet manifest.");
  const manifest = await response.json();
  const mapResponse = await fetch("/map-config.json");
  if (!mapResponse.ok) throw new Error("Could not load map configuration.");
  const mapConfiguration = await mapResponse.json();
  createClient = (dataPath, report, fail) =>
    createFleetClient(dataPath, report, fail, manifest, mapConfiguration);
}

const status = document.querySelector("#status");
const step = document.querySelector("#step");
const play = document.querySelector("#play");
const pause = document.querySelector("#pause");
const disconnect = document.querySelector("#disconnect");
const reconnect = document.querySelector("#reconnect");
const interrupt = document.querySelector("#interrupt");
const restore = document.querySelector("#restore");
const reset = document.querySelector("#reset");
const controlError = document.querySelector("#control-error");
const target = document.querySelector("#viewer-target");
let viewerSession;
let lastRunState;
function updateAuthority() {
  if (!lastRunState) return;
  const state = lastRunState;
  step.disabled = play.disabled = state.phase !== "ready" || state.playing;
  pause.disabled = !state.playing;
  reset.disabled = ["starting", "resetting", "closed"].includes(state.phase);
  interrupt.disabled =
    restore.disabled =
    disconnect.disabled =
    reconnect.disabled =
      state.playing || !["ready", "complete"].includes(state.phase);
  if (state.external && !viewerSession?.controller)
    for (const button of [
      step,
      play,
      pause,
      reset,
      disconnect,
      reconnect,
      interrupt,
      restore,
    ])
      button.disabled = true;
  if (target) target.disabled = !viewerSession?.controller;
}
for (const [button, action] of [
  [step, "step"],
  [play, "play"],
  [pause, "pause"],
  [reset, "reset"],
  [disconnect, "disconnect"],
  [reconnect, "reconnect"],
  [interrupt, "interrupt"],
  [restore, "restore"],
]) {
  button.addEventListener("click", () => {
    controlError.textContent = "";
    button.disabled = true;
    const targeted = [
      "disconnect",
      "reconnect",
      "interrupt",
      "restore",
    ].includes(action);
    bridge.requestControl(action, targeted ? target?.value : undefined);
  });
}

const bridge = startBrowserBridge({
  onRunChanged() {
    lastRunState = undefined;
    resetActivity();
    document.querySelector("#next-step").textContent = "";
    document.querySelector("#run-progress").textContent =
      "Waiting for the new run.";
    document.querySelector("#run-mode").textContent = "Scripted run";
    controlError.textContent = "";
    for (const button of [
      step,
      play,
      pause,
      reset,
      disconnect,
      reconnect,
      interrupt,
      restore,
    ])
      button.disabled = true;
  },
  createClient(dataPath, report, fail) {
    document.body.dataset.dataPath = dataPath;
    return createClient(
      dataPath,
      (message) => {
        report(message);
        recordObservation(message);
      },
      fail,
    );
  },
  onStatus(state, context) {
    const messages = {
      unregistered: "Open this demo through Workbench.",
      ready: "Connected to Workbench",
      failed: context.external
        ? "This viewer failed · refresh to rejoin or reset the shared run."
        : "Workbench run failed · playback stopped",
      closed: context.external
        ? "This viewer disconnected · refresh to rejoin, or use a new pairing link."
        : "Workbench disconnected · playback stopped",
      error: "Could not connect to Workbench.",
    };
    status.textContent = messages[state];
    if (state === "closed") {
      for (const button of [
        step,
        play,
        pause,
        reset,
        disconnect,
        reconnect,
        interrupt,
        restore,
      ])
        button.disabled = true;
      controlError.textContent =
        "Control connection lost. External viewers can refresh to rejoin; owned-browser mode can reset from the terminal.";
    }
  },
  onRunState(state, client) {
    if (state.kind === "viewer-session") {
      viewerSession = state;
      const role = document.querySelector("#viewer-role");
      role.hidden = false;
      role.textContent = state.controller
        ? "You control this shared run."
        : "Observer · selection is local; playback is controlled by another viewer or the terminal.";
      document.querySelector("#viewer-target-label").hidden = false;
      const selected = target.value || state.viewerId;
      target.replaceChildren(
        ...state.viewers.map((viewer) => {
          const option = document.createElement("option");
          option.value = viewer.id;
          option.textContent = `${viewer.name}${viewer.connected ? "" : " (disconnected)"}`;
          return option;
        }),
      );
      target.value = state.viewers.some((viewer) => viewer.id === selected)
        ? selected
        : state.viewerId;
      updateAuthority();
      return;
    }
    if (state.kind === "data-fault") {
      recordFault(state.action);
      return;
    }
    if (state.kind === "expect-data-fault") {
      client.expectRecovery(state.timeoutMs);
      return;
    }
    if (state.kind === "vehicle-source-sent") {
      recordSourceSend(state);
      return;
    }

    lastRunState = state;
    document.querySelector("#next-step").textContent = state.nextStep ?? "";
    document.querySelector("#workbench-controls").hidden = false;
    if (state.phase === "failed") client?.fail(state.detail);
    step.disabled = state.phase !== "ready" || state.playing;
    play.disabled = state.phase !== "ready" || state.playing;
    pause.disabled = !state.playing;
    interrupt.disabled =
      restore.disabled =
      disconnect.disabled =
      reconnect.disabled =
        state.playing || !["ready", "complete"].includes(state.phase);
    document.querySelector("#run-mode").textContent = state.external
      ? "External demonstration · source/HTTP checks only; viewer behaviour is exploratory."
      : state.exploratory
        ? `Exploratory · ${state.interventions} manual intervention(s) · Last: ${state.lastIntervention} · ${state.skippedChecks} client checks skipped. Reset for a scripted run.`
        : "Scripted run";
    reset.disabled = ["starting", "resetting", "closed"].includes(state.phase);
    document.querySelector("#run-progress").textContent =
      `${state.completed}/${state.total} ${state.external ? "source steps checked" : state.exploratory ? "steps executed" : "steps checked"} · ${state.detail}`;
    controlError.textContent = "";
    updateAuthority();
  },
  onControlRejected(reason) {
    controlError.textContent = reason;
    updateAuthority();
  },
});
