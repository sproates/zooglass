import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import {
  recoveryWitness,
  type RecoverySnapshot,
} from "../../src/demos/orders/recovery.js";

function fixture() {
  let id = "";
  const socket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send(raw: string) {
      id = JSON.parse(raw).id;
    },
  }) as unknown as WebSocket;
  const witness = recoveryWitness(new Set([socket]));
  const snapshots: RecoverySnapshot[] = [
    "order-summary",
    "order-tracking",
  ].flatMap((viewId) =>
    Array.from({ length: 6 }, (_, i) => ({
      viewId,
      entityId: `order-${i + 1}`,
      data: { status: "accepted" },
      provenance: {},
      publicationSequences: {},
      status: {
        publication: "published",
        missingRequiredFields: [],
        inputs: {},
      },
    })),
  );
  return {
    socket,
    witness,
    snapshots,
    send(stage: string, snapshots?: RecoverySnapshot[]) {
      witness.receive(socket, { id, stage, snapshots });
    },
  };
}
for (const corrupt of [false, true])
  test(`recovery witness ${corrupt ? "rejects changed" : "accepts matching"} first baselines`, async () => {
    const f = fixture();
    const armed = f.witness.arm(new AbortController().signal, f.snapshots);
    f.send("armed");
    const active = await armed;
    f.send("lost");
    await active.lost;
    const result = active.baseline();
    const checked = corrupt ? assert.rejects(result) : result;
    const snapshots = structuredClone(f.snapshots);
    if (corrupt) snapshots[0].data = { status: "different" };
    f.send("baseline", snapshots);
    await checked;
    active.dispose();
  });
test("recovery witness rejects a lost control owner and ignores old identifiers", async () => {
  const f = fixture();
  const abort = new AbortController();
  const armed = f.witness.arm(abort.signal, f.snapshots);
  f.witness.receive(f.socket, { id: "old", stage: "armed" });
  f.send("armed");
  const active = await armed;
  const rejected = assert.rejects(active.lost, /disconnected/);
  f.socket.emit("close");
  await rejected;
  active.dispose();
});

test("recovery witness preserves loss acknowledged in the same message batch as arming", async () => {
  const f = fixture();
  const armed = f.witness.arm(new AbortController().signal, f.snapshots);
  f.send("armed");
  // Separate WebSocket frames can be dispatched before the arm continuation runs.
  f.send("lost");
  const active = await armed;
  try {
    let lost = false;
    void active.lost.then(() => {
      lost = true;
    });
    await Promise.resolve();
    assert.equal(lost, true, "Loss must not wait for the replacement baseline");
    const baseline = active.baseline();
    f.send("baseline", f.snapshots);
    await baseline;
  } finally {
    active.dispose();
  }
});
