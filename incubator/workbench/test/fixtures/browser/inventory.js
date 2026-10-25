import { startBrowserBridge } from "/bridge.js";

// Minimal data client fixture; registration and commands use the shared bridge.
startBrowserBridge({
  createClient(dataPath, report) {
    let data;
    let observationIndex = 0;
    return {
      execute(command) {
        if (command.action !== "connect")
          throw new Error("Fixture only supports connect.");
        return new Promise((resolve, reject) => {
          data = new WebSocket(`ws://${location.host}${dataPath}`);
          data.onerror = () =>
            reject(new Error("Fixture data connection failed."));
          data.onopen = () => {
            report({
              type: "observation",
              event: "opened",
              connectionGeneration: 1,
              observationIndex: ++observationIndex,
            });
            resolve(1);
          };
          data.onmessage = (receipt) => {
            const view = JSON.parse(receipt.data);
            report({
              type: "observation",
              event: "view-update",
              connectionGeneration: 1,
              observationIndex: ++observationIndex,
              viewId: view.viewId,
              entityId: view.entityId,
              data: view.data,
            });
          };
        });
      },
      fail() {
        data?.close();
      },
      close() {
        data?.close();
      },
    };
  },
});
