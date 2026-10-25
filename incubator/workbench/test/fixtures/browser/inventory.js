// Minimal protocol fixture, deliberately independent of vehicle assets and DOM.
const registration = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, "", "/");
const runId = registration.get("runId");
const clientId = registration.get("clientId");
const control = new WebSocket(`ws://${location.host}/control`);
const send = (message) =>
  control.send(JSON.stringify({ ...message, runId, clientId }));
let dataPath;
let observationIndex = 0;
control.onopen = () =>
  send({
    type: "register",
    protocolVersion: 1,
    token: registration.get("token"),
  });
control.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "registered") {
    dataPath = message.dataPath;
    send({ type: "ready" });
  } else if (message.type === "command" && message.action === "connect") {
    const data = new WebSocket(`ws://${location.host}${dataPath}`);
    data.onopen = () => {
      send({
        type: "observation",
        event: "opened",
        connectionGeneration: 1,
        observationIndex: ++observationIndex,
      });
      send({
        type: "completed",
        commandId: message.commandId,
        connectionGeneration: 1,
      });
    };
    data.onmessage = (receipt) => {
      const view = JSON.parse(receipt.data);
      send({
        type: "observation",
        event: "view-update",
        connectionGeneration: 1,
        observationIndex: ++observationIndex,
        viewId: view.viewId,
        entityId: view.entityId,
        data: view.data,
      });
    };
  }
};
