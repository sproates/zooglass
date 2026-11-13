import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

export interface RecoverySnapshot {
  viewId: string;
  entityId: string;
  data: unknown;
  provenance: unknown;
  publicationSequences: unknown;
  status: {
    publication: string;
    missingRequiredFields: string[];
    inputs: unknown;
  };
}
/** Versions and receipt-age freshness may advance while the service is stopped. */
export function durableSnapshot(snapshot: RecoverySnapshot) {
  return {
    viewId: snapshot.viewId,
    entityId: snapshot.entityId,
    data: snapshot.data,
    provenance: snapshot.provenance,
    publicationSequences: snapshot.publicationSequences,
    publication: snapshot.status.publication,
    missingRequiredFields: snapshot.status.missingRequiredFields,
    inputs: snapshot.status.inputs,
  };
}
export async function readOrderSnapshots(
  baseUrl: string,
  signal: AbortSignal,
): Promise<RecoverySnapshot[]> {
  const snapshots: RecoverySnapshot[] = [];
  for (const viewId of ["order-summary", "order-tracking"]) {
    for (let i = 1; i <= 6; i++) {
      const response = await fetch(`${baseUrl}/views/${viewId}/order-${i}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      });
      if (!response.ok)
        throw new Error(`Recovery snapshot failed: ${response.status}`);
      snapshots.push(await response.json());
    }
  }
  return snapshots;
}

function acknowledgement() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accepted, failed) => {
    resolve = accepted;
    reject = failed;
  });
  // Later stages may fail while the run is still retiring or starting a JVM.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

/** One bounded witness on the existing control channel, never a source of view values. */
export function recoveryWitness(clients: Set<WebSocket>) {
  let receive:
    ((socket: WebSocket, message: Record<string, unknown>) => void) | undefined;
  return {
    receive(socket: WebSocket, message: Record<string, unknown>) {
      receive?.(socket, message);
    },
    async arm(signal: AbortSignal, expected: RecoverySnapshot[]) {
      const id = randomUUID();
      const timeout = AbortSignal.timeout(30000);
      const active = AbortSignal.any([signal, timeout]);
      let owner: WebSocket | undefined;
      const stages = {
        armed: acknowledgement(),
        lost: acknowledgement(),
        baseline: acknowledgement(),
      };
      let stage: keyof typeof stages | "done" = "armed";
      const fail = (error: unknown) => {
        stage = "done";
        for (const pending of Object.values(stages)) pending.reject(error);
      };
      const aborted = () => fail(active.reason);
      active.addEventListener("abort", aborted, { once: true });
      const closed = () =>
        fail(
          new Error(
            "Recovery viewer disconnected its controls. Keep the page open and Reset.",
          ),
        );
      const dispose = () => {
        active.removeEventListener("abort", aborted);
        owner?.off("close", closed);
        receive = undefined;
      };
      receive = (socket, message) => {
        if (
          stage === "done" ||
          message.id !== id ||
          message.stage !== stage ||
          (owner && socket !== owner)
        )
          return;
        try {
          if (stage === "armed") {
            owner = socket;
            owner.once("close", closed);
            stage = "lost";
            stages.armed.resolve();
          } else if (stage === "lost") {
            stage = "baseline";
            stages.lost.resolve();
          } else {
            assert.ok(Array.isArray(message.snapshots));
            assert.equal(message.snapshots.length, 12);
            const byKey = new Map(
              message.snapshots.map((snapshot: RecoverySnapshot) => [
                `${snapshot.viewId}/${snapshot.entityId}`,
                snapshot,
              ]),
            );
            assert.equal(byKey.size, 12);
            for (const snapshot of expected)
              assert.deepEqual(
                durableSnapshot(
                  byKey.get(`${snapshot.viewId}/${snapshot.entityId}`)!,
                ),
                durableSnapshot(snapshot),
              );
            stage = "done";
            stages.baseline.resolve();
          }
        } catch (error) {
          fail(error);
        }
      };
      try {
        active.throwIfAborted();
        for (const socket of clients)
          if (
            socket.readyState === WebSocket.OPEN &&
            socket.bufferedAmount < 65536
          )
            socket.send(JSON.stringify({ kind: "recovery", id }));
        await stages.armed.promise;
        return {
          lost: stages.lost.promise,
          async baseline() {
            await stages.lost.promise;
            await stages.baseline.promise;
            active.throwIfAborted();
          },
          dispose,
        };
      } catch (error) {
        dispose();
        throw new Error(
          "Recovery needs a connected viewer and matching fresh baselines within 30 seconds. Open the page and Reset.",
          { cause: error },
        );
      }
    },
  };
}
