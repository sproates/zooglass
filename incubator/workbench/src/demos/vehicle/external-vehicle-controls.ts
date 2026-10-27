import type { BrowserRun } from "../../browser/browser-run.js";
import type { Scenario } from "../../scenario/scenario.js";

export function fleetSubscriptions(scenario: Scenario) {
  const pairs = new Map<string, { viewId: string; entityId: string }>();
  for (const entry of scenario.timeline) {
    if (entry.kind === "client-subscription" && entry.action === "subscribe")
      pairs.set(JSON.stringify([entry.viewId, entry.entityId]), {
        viewId: entry.viewId,
        entityId: entry.entityId,
      });
  }
  return [...pairs.values()];
}

/** Apply a targeted manual action through that viewer's real control and data sockets. */
export function externalVehicleControls(scenario: Scenario) {
  const subscriptions = fleetSubscriptions(scenario);
  const interrupted = new WeakSet<BrowserRun>();
  const execute = (run: BrowserRun, state: "connected" | "disconnected") =>
    run.executor.execute(
      {
        kind: "client-state",
        clientId: run.clientId,
        clientName: "External viewer",
        simulationTime: 0,
        state,
      },
      run.signal,
    );
  async function connect(run: BrowserRun) {
    await execute(run, "connected");
    for (const pair of subscriptions)
      await run.executor.execute(
        {
          kind: "client-subscription",
          clientId: run.clientId,
          clientName: "External viewer",
          simulationTime: 0,
          action: "subscribe",
          ...pair,
        },
        run.signal,
      );
  }
  return {
    connect,
    async apply(
      run: BrowserRun,
      action: "disconnect" | "reconnect" | "interrupt" | "restore",
    ) {
      if (action === "disconnect" || action === "reconnect") {
        if (interrupted.has(run))
          throw new Error(
            "Restore the interrupted route before changing its connection.",
          );
        if (action === "disconnect") await execute(run, "disconnected");
        else await connect(run);
        return;
      }
      const cursor = run.observations.cursor();
      const identity = { runId: run.runId, clientId: run.clientId };
      if (action === "interrupt") {
        if (interrupted.has(run))
          throw new Error("Viewer data route is already interrupted.");
        run.publish({ kind: "expect-data-fault", timeoutMs: 30_000 });
        await run.observations.wait("recovery-armed", cursor, run.signal, 5000);
        await run.controlDataConnection({ ...identity, action: "break" });
        interrupted.add(run);
        run.publish({ kind: "data-fault", action: "break" });
        await run.observations.wait("retry-failed", cursor, run.signal);
      } else {
        if (!interrupted.has(run))
          throw new Error("Viewer data route is not interrupted.");
        await run.controlDataConnection({ ...identity, action: "restore" });
        run.publish({ kind: "data-fault", action: "restore" });
        await run.observations.wait("recovered", cursor, run.signal);
        interrupted.delete(run);
      }
    },
  };
}
