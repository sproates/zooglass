import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, connect, type Socket } from "node:net";
import type { TestContext } from "node:test";
import { WebSocket } from "ws";
import { startZooGlassSession } from "../../../src/service/zooglass-session.js";
import { protectedAuthority } from "./protected-authority.js";

/** Real protected ZooGlass, operator publication and an end-to-end TLS fault gate. */
export async function protectedService(t: TestContext) {
  const {
    store,
    password,
    trustStore,
    origin,
    serviceToken,
    allowed,
    failures,
    decisions,
  } = await protectedAuthority(t);
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const operator = reservation.address();
  assert.ok(operator && typeof operator !== "string");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const operatorToken = "fixture-operator-token-at-least-32-characters";
  const service = await startZooGlassSession({
    views: [
      {
        id: "live-map",
        fields: { position: [{ sourceId: "gps", type: "position" }] },
      },
      {
        id: "trip-history",
        fields: { positions: [{ sourceId: "gps", type: "position" }] },
        ordering: {
          positions: {
            mode: "historyBySequence",
            sequenceField: "publicationSequence",
          },
        },
      },
    ],
    protectedAccess: {
      keyStore: store,
      keyStorePassword: password,
      trustStore,
      trustStorePassword: password,
      tenant: "acceptance",
      policyUrl: `${origin}/policy`,
      serviceToken,
      origin,
      operatorPort: operator.port,
      operatorToken,
    },
  });
  t.after(() => service.close());

  // A transparent TCP fault gate preserves end-to-end TLS and real admission.
  const peers = new Set<Socket>();
  let interrupted = false;
  const gate = createServer((downstream) => {
    if (interrupted) {
      downstream.destroy();
      return;
    }
    const upstream = connect(
      Number(new URL(service.baseUrl).port),
      "127.0.0.1",
    );
    for (const socket of [downstream, upstream]) {
      peers.add(socket);
      socket.on("error", () => {
        downstream.destroy();
        upstream.destroy();
      });
      socket.on("close", () => {
        peers.delete(socket);
        downstream.destroy();
        upstream.destroy();
      });
    }
    downstream.pipe(upstream).pipe(downstream);
  });
  await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of peers) socket.destroy();
    await new Promise<void>((resolve) => gate.close(() => resolve()));
  });
  const gateAddress = gate.address();
  assert.ok(gateAddress && typeof gateAddress !== "string");
  const source = new WebSocket(`ws://127.0.0.1:${operator.port}/events`, {
    headers: { Authorization: `Bearer ${operatorToken}` },
  });
  t.after(() => source.terminate());
  await once(source, "open");
  let sequence = 0;
  async function publish(value: number) {
    const position = { sequence: value, latitude: 51.2, longitude: -0.1 };
    const receipt = once(source, "message", {
      signal: AbortSignal.timeout(5000),
    });
    source.send(
      JSON.stringify({
        sourceId: "gps",
        type: "position",
        epoch: "run",
        sourceEntityId: "car-17",
        publicationSequence: ++sequence,
        payload: position,
      }),
    );
    assert.equal(JSON.parse((await receipt)[0].toString()).status, "applied");
  }
  return {
    origin,
    allowed,
    failures,
    decisions,
    publish,
    viewerUrl: `wss://localhost:${gateAddress.port}/views/live`,
    restore() {
      interrupted = false;
    },
    healthyUrl: service.baseUrl.replace("https:", "wss:") + "/views/live",
    interrupt() {
      interrupted = true;
      for (const socket of peers) socket.destroy();
    },
  };
}
