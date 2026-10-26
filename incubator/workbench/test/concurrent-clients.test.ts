import assert from "node:assert/strict";
import test from "node:test";
import { startZooGlassSession } from "../src/zooglass-session.js";
import { liveClient, positionEvent } from "./support/live-client.js";

const views = [
  {
    id: "position",
    fields: { position: [{ sourceId: "feed", type: "position" }] },
    ordering: {
      position: {
        mode: "latestBySequence" as const,
        sequenceField: "sequence",
      },
    },
  },
];

test(
  "concurrent entity streams remain isolated while a viewer disconnects and rejoins",
  { timeout: 60_000 },
  async () => {
    const service = await startZooGlassSession({ views });
    const clients: Awaited<ReturnType<typeof liveClient>>[] = [];

    const connect = async (path?: string) => {
      const client = await liveClient(service.baseUrl, path);
      clients.push(client);

      return client;
    };

    try {
      const sourceA = await connect("/events");
      const sourceB = await connect("/events");
      const viewerA = await connect();
      const viewerB = await connect();
      const reconnecting = await connect();

      await viewerA.subscription("car-a");
      await viewerB.subscription("car-b");
      await reconnecting.subscription("car-a");
      await sourceA.send(positionEvent("car-a", 0));

      assert.equal((await viewerA.next()).data?.position.sequence, 0);
      assert.equal((await reconnecting.next()).data?.position.sequence, 0);
      await reconnecting.close();

      await Promise.all(
        [
          [sourceA, viewerA, "car-a"] as const,
          [sourceB, viewerB, "car-b"] as const,
        ].map(async ([source, viewer, entity]) => {
          for (let sequence = 1; sequence <= 50; sequence++) {
            await source.send(positionEvent(entity, sequence));

            assert.deepEqual(await viewer.next(), {
              type: "view-update",
              viewId: "position",
              entityId: entity,
              data: { position: { sequence, padding: "" } },
            });
          }
        }),
      );

      const fresh = await connect();

      await fresh.subscription("car-a");

      assert.equal((await fresh.next()).data?.position.sequence, 50);
      // Use a second subscription as an ordered barrier after removing the first.
      await fresh.subscription("car-b");

      assert.equal((await fresh.next()).entityId, "car-b");
      await fresh.subscription("car-a", "unsubscribe");
      await sourceA.send(positionEvent("car-a", 51));

      assert.equal((await viewerA.next()).data?.position.sequence, 51);
      await sourceA.send(positionEvent("car-b", 51));

      assert.equal((await viewerB.next()).data?.position.sequence, 51);

      const barrier = await fresh.next();

      assert.equal(
        barrier.entityId,
        "car-b",
        "unsubscribed entity must not leak before the barrier",
      );
      assert.equal(barrier.data?.position.sequence, 51);
    } finally {
      try {
        await Promise.all(clients.map((client) => client.close()));
      } finally {
        await service.close();
      }
    }

    await assert.rejects(
      fetch(service.baseUrl + "/actuator/health", {
        signal: AbortSignal.timeout(1000),
      }),
    );
  },
);

test(
  "a paused real receiver is evicted without interrupting a healthy subscriber",
  { timeout: 90_000 },
  async () => {
    const service = await startZooGlassSession({ views });
    const clients: Awaited<ReturnType<typeof liveClient>>[] = [];

    try {
      for (const path of ["/events", "/views/live", "/views/live"])
        clients.push(await liveClient(service.baseUrl, path));

      const [source, healthy, slow] = clients;

      await healthy.subscription("bus");
      await slow.subscription("bus");
      slow.socket.pause();

      // A bounded transport-pressure workload, not a throughput benchmark. Await
      // healthy receipt each time so producer bursts don't also overload that client.
      const padding = "x".repeat(4096);

      for (let sequence = 1; sequence <= 2048; sequence++) {
        await source.send(positionEvent("bus", sequence, padding));

        const message = await healthy.next();

        assert.equal(message.entityId, "bus");
        assert.equal(message.data?.position.sequence, sequence);
      }
      slow.socket.resume();

      const timeout = AbortSignal.timeout(10_000);
      const [code] = await Promise.race([
        slow.closed.then((code) => [code]),
        new Promise<never>((_, reject) =>
          timeout.addEventListener(
            "abort",
            () => reject(new Error("Paused receiver was not evicted")),
            { once: true },
          ),
        ),
      ]);

      assert.ok(
        [1013, 1006].includes(code),
        `Unexpected slow receiver close: ${code}`,
      );
      // A cancelled blocked write may prevent delivery of the requested 1013
      // close frame. The deterministic Java test verifies that requested status.
      await source.send(positionEvent("bus", 2049));

      assert.equal((await healthy.next()).data?.position.sequence, 2049);

      const rejoined = await liveClient(service.baseUrl);

      clients.push(rejoined);
      await rejoined.subscription("bus");

      assert.equal((await rejoined.next()).data?.position.sequence, 2049);
      await source.send(positionEvent("bus", 2050));

      assert.equal((await healthy.next()).data?.position.sequence, 2050);
      assert.equal((await rejoined.next()).data?.position.sequence, 2050);

      const response = await fetch(service.baseUrl + "/views/position/bus", {
        signal: AbortSignal.timeout(5000),
      });

      assert.equal(response.status, 200);
      assert.equal((await response.json()).data.position.sequence, 2050);
    } finally {
      try {
        await Promise.all(clients.map((client) => client.close()));
      } finally {
        await service.close();
      }
    }
  },
);
