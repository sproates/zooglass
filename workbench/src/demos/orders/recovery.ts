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
      let stage = "armed";
      let resolveStage!: () => void;
      let rejectStage!: (error: unknown) => void;
      let next = new Promise<void>((resolve, reject) => {
        resolveStage = resolve;
        rejectStage = reject;
      });
      const aborted = () => rejectStage(active.reason);
      active.addEventListener("abort", aborted, { once: true });
      const closed = () =>
        rejectStage(
          new Error(
            "Recovery viewer disconnected its controls. Keep the page open and Reset.",
          ),
        );
      const dispose = () => {
        active.removeEventListener("abort", aborted);
        owner?.off("close", closed);
        receive = undefined;
      };
      const advance = (nextStage: string) => {
        const done = resolveStage;
        stage = nextStage;
        next = new Promise<void>((resolve, reject) => {
          resolveStage = resolve;
          rejectStage = reject;
        });
        void next.catch(() => {});
        done();
      };
      receive = (socket, message) => {
        if (
          message.id !== id ||
          message.stage !== stage ||
          (owner && socket !== owner)
        )
          return;
        try {
          if (stage === "armed") {
            owner = socket;
            owner.once("close", closed);
            advance("lost");
          } else if (stage === "lost") advance("baseline");
          else {
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
            resolveStage();
          }
        } catch (error) {
          rejectStage(error);
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
        await next;
        const lost = next;
        return {
          lost,
          async baseline() {
            await lost;
            await next;
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
