import { startBrowserBridge } from "/bridge.js";

window.clients = [];
startBrowserBridge({
  createClient(_dataPath, report) {
    const entry = { report, closed: false };
    window.clients.push(entry);
    return {
      execute() {
        return new Promise((resolve) => {
          entry.complete = resolve;
        });
      },
      close() {
        entry.closed = true;
      },
      fail() {},
    };
  },
});
