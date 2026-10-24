const registration = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, "", "/");
const runId = registration.get("runId");
const clientId = registration.get("clientId");
const status = document.querySelector("#status");
if (!runId || !clientId || !registration.get("token")) {
  status.textContent = "Open this demo through Workbench.";
} else {
  const control = new WebSocket(`ws://${location.host}/control`);
  control.addEventListener("open", () => {
    control.send(
      JSON.stringify({
        type: "register",
        protocolVersion: 1,
        runId,
        clientId,
        token: registration.get("token"),
      }),
    );
    registration.delete("token");
  });
  control.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (
      message.type !== "registered" ||
      message.runId !== runId ||
      message.clientId !== clientId
    ) {
      control.close();
      return;
    }
    // The future app controller uses this route for its own ZooGlass socket.
    document.body.dataset.dataPath = message.dataPath;
    control.send(JSON.stringify({ type: "ready", runId, clientId }));
    status.textContent = "Connected to Workbench. Vehicle display pending.";
  });
  control.addEventListener("close", () => {
    status.textContent = "Workbench disconnected.";
  });
  control.addEventListener("error", () => {
    status.textContent = "Could not connect to Workbench.";
  });
}
