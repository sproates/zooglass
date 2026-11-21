import assert from "node:assert/strict";
import { on, once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { loadCars } from "../src/demos/vehicle/continuous/journeys.js";
import { startProducer } from "../src/demos/vehicle/continuous/producer.js";
import { drivingView } from "../src/demos/vehicle/continuous/simulation.js";
import { startZooGlassSession } from "../src/service/zooglass-session.js";

test(
  "real ZooGlass reconciles repeated delivery faults without reconstructing missing events",
  { timeout: 180_000 },
  async (t) => {
    const cars = await loadCars();
    assert.equal(cars.length, 6);
    const service = await startZooGlassSession({
      views: [drivingView],
      signal: t.signal,
    });
    t.after(() => service.close());
    const socket = new WebSocket(
      service.baseUrl.replace("http:", "ws:") + "/views/live",
    );
    // Six streams await individual receipts at every tick. Assert the two cycles by
    // sequence and allow their wall time to vary on shared CI runners.
    const deadline = AbortSignal.timeout(90_000);
    const signal = AbortSignal.any([deadline, service.signal]);
    const messages = on(socket, "message", { close: ["close"], signal });
    const reports = new Map<string, Set<number>>();
    const notices = new Set<string>();
    const latest = new Map<string, number>();
    const baselines = new Set<string>();
    const acknowledged = new Set<string>();
    const nextMessage = async () => {
      const item = await messages.next();
      if (item.done)
        throw new Error("Viewer closed before both fault cycles completed");
      return JSON.parse(String(item.value[0]));
    };
    try {
      await once(socket, "open", { signal });
      for (const car of cars) {
        socket.send(
          JSON.stringify({
            action: "subscribe",
            viewId: "driving",
            entityId: car.id,
          }),
        );
      }
      while (baselines.size < cars.length) {
        const message = await nextMessage();
        assert.ok(cars.some((car) => car.id === message.entityId));
        assert.equal(message.viewId, "driving");
        if (message.type === "subscribed") {
          assert.ok(!acknowledged.has(message.entityId));
          acknowledged.add(message.entityId);
        } else {
          assert.equal(message.type, "view-update");
          assert.ok(acknowledged.has(message.entityId));
          assert.ok(!baselines.has(message.entityId));
          assert.deepEqual(message.data, {});
          baselines.add(message.entityId);
        }
      }
      const producer = await startProducer(service.baseUrl, cars, {
        tickMs: 15,
        signal,
      });
      try {
        async function observeCycles() {
          while (
            latest.size < cars.length ||
            [...latest.values()].some((value) => value < 365)
          ) {
            const message = await nextMessage();
            assert.equal(message.type, "view-update");
            assert.ok(baselines.has(message.entityId));
            if (!message.data.position) continue;
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
          }
        }
        await Promise.race([
          observeCycles(),
          producer.done.then(() => {
            throw new Error(
              "Producer ended before both fault cycles completed",
            );
          }),
        ]);
      } finally {
        await producer.close();
      }
      const first = reports.get("car-1")!;
      for (const absent of [11, 51, 71, 80, 90, 111, 120, 130, 191, 231]) {
        assert.equal(
          first.has(absent),
          false,
          `report ${absent} must not be reconstructed or replace a newer one`,
        );
      }
      for (const present of [12, 31, 52, 91, 131, 192, 211, 232, 271, 311]) {
        assert.equal(
          first.has(present),
          true,
          `report ${present} is delivered`,
        );
      }
      for (const text of [
        "delayed report sent after newer reports",
        "duplicate report sent",
        "one report permanently lost",
        "source reconnected",
        "stopped reporting; source remains connected",
        "reporting resumed",
      ]) {
        assert.ok(notices.has(text), text);
      }
    } catch (cause) {
      if (deadline.aborted) {
        throw new Error(
          `Timed out waiting for two fault cycles. Baselines: ${baselines.size}/${cars.length}. Latest sequence by car: ${JSON.stringify(Object.fromEntries(latest))}. Notices: ${[...notices].join(", ")}`,
          { cause },
        );
      }
      throw cause;
    } finally {
      socket.terminate();
      await messages.return();
    }
  },
);
