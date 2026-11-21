// Resolve only after the application and its required configuration have loaded.
import("./app.js").then(
  () => window.dispatchEvent(new Event("fleet-ready")),
  () => window.dispatchEvent(new Event("fleet-startup-failed")),
);
