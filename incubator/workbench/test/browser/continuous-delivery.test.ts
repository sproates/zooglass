import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { startSimulation } from "../../src/demos/vehicle/continuous/simulation.js";

test(
  "real ZooGlass reconciles repeated delivery faults without reconstructing missing events",
  { timeout: 30_000 },
  async () => {
    const simulation = await startSimulation({ tickMs: 15 });
    const socket = new WebSocket(
      simulation.baseUrl.replace("http:", "ws:") + "/views/live",
    );
    try {
      const reports = new Map<string, Set<number>>();
      const notices = new Set<string>();
      const latest = new Map<string, number>();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Did not complete two fault cycles")),
          15_000,
        );
        socket.on("error", reject);
        socket.on("open", () => {
          for (const car of simulation.cars)
            socket.send(
              JSON.stringify({
                action: "subscribe",
                viewId: "driving",
                entityId: car.id,
              }),
            );
        });
        socket.on("message", (data) => {
          try {
            const message = JSON.parse(String(data));
            if (message.type !== "view-update" || !message.data.position)
              return;
            const sequence = message.data.position.sequence;
            assert.ok(
              sequence >= (latest.get(message.entityId) ?? 0),
              "accepted positions never roll back",
            );
            latest.set(message.entityId, sequence);
            const seen = reports.get(message.entityId) ?? new Set<number>();
            seen.add(sequence);
            reports.set(message.entityId, seen);
            if (message.data.notice) notices.add(message.data.notice.text);
            if (
              latest.size === 6 &&
              [...latest.values()].every((value) => value >= 365)
            ) {
              clearTimeout(timer);
              resolve();
            }
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        });
      });
      const first = reports.get("car-1")!;
      for (const absent of [11, 51, 71, 80, 90, 111, 120, 130, 191, 231])
        assert.equal(
          first.has(absent),
          false,
          `report ${absent} must not be reconstructed or replace a newer one`,
        );
      for (const present of [12, 31, 52, 91, 131, 192, 211, 232, 271, 311])
        assert.equal(
          first.has(present),
          true,
          `report ${present} is delivered`,
        );
      for (const text of [
        "delayed report sent after newer reports",
        "duplicate report sent",
        "one report permanently lost",
        "source reconnected",
        "stopped reporting; source remains connected",
        "reporting resumed",
      ])
        assert.ok(notices.has(text), text);
    } finally {
      socket.terminate();
      await simulation.close();
    }
  },
);
