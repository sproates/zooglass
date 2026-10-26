import assert from "node:assert/strict";
import type {
  DataConnectionFaultTraceEntry,
  TraceEntry,
} from "../../scenario/playback.js";
import type { startBrowserHost } from "../../browser/browser-host.js";

type BrowserHost = Awaited<ReturnType<typeof startBrowserHost>>;

/** Compose the shared gate and observation channel for the vehicle fault scenario. */
export function createVehicleFaults(host: BrowserHost) {
  let interrupted = false;
  let verifyInitialSnapshots = false;
  const checked = new Set<string>();

  return {
    async execute(entry: DataConnectionFaultTraceEntry, signal: AbortSignal) {
      if (entry.clientId !== host.clientId)
        throw new Error("Unbound fault client.");
      const cursor = host.observations.cursor();
      const identity = { runId: host.runId, clientId: host.clientId };
      if (entry.action === "break") {
        if (interrupted)
          throw new Error("The data route is already interrupted.");
        host.publish({ kind: "expect-data-fault", timeoutMs: entry.timeoutMs });
        await host.observations.wait("recovery-armed", cursor, signal, 5000);
        await host.controlDataConnection({ ...identity, action: "break" });
        interrupted = true;
        host.publish({ kind: "data-fault", action: "break" });
        await host.observations.wait("interrupted", cursor, signal);
        await host.observations.wait("retry-failed", cursor, signal);
      } else {
        if (!interrupted) throw new Error("The data route is not interrupted.");
        await host.controlDataConnection({ ...identity, action: "restore" });
        host.publish({ kind: "data-fault", action: "restore" });
        await host.observations.wait("recovered", cursor, signal);
        interrupted = false;
        verifyInitialSnapshots = true;
        checked.clear();
      }
    },
    check(entry: TraceEntry) {
      if (!verifyInitialSnapshots || entry.kind !== "client-view-check") return;
      const key = JSON.stringify([entry.viewId, entry.entityId]);
      if (checked.has(key)) return;
      assert.deepEqual(
        host.observations.firstView(entry.viewId, entry.entityId),
        entry.expected,
        `First recovery snapshot for ${entry.viewId} (${entry.entityId})`,
      );
      checked.add(key);
    },
  };
}
