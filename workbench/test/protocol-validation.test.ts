import assert from "node:assert/strict";
import test from "node:test";
import { startZooGlassSession } from "../src/service/zooglass-session.js";
import { createNodeClientExecutor } from "../src/execution/node-client-executor.js";
import { liveClient, positionEvent } from "./support/live-client.js";

const views = [
  {
    id: "position",
    fields: { position: [{ sourceId: "feed", type: "position" }] },
    ordering: {
      position: {
        mode: "latestBySequence" as const,
        sequenceField: "publicationSequence",
      },
    },
  },
];

const valid = { action: "subscribe", viewId: "position", entityId: "bus" };

const invalidRequests: [string, string][] = [
  ["{", "Could not read live view request."],
  ...[
    null,
    [],
    1,
    {},
    ...["action", "viewId", "entityId"].flatMap((field) =>
      [undefined, null, 42, " "].map((value) => ({ ...valid, [field]: value })),
    ),
  ].map((message): [string, string] => [
    JSON.stringify(message),
    "Expected action, viewId, and entityId text fields.",
  ]),
  [JSON.stringify({ ...valid, action: "unknown" }), "Unknown action: unknown"],
  [JSON.stringify({ ...valid, viewId: "absent" }), "Unknown view: absent"],
];

test(
  "invalid live requests return errors without disrupting subscriptions or later requests",
  { timeout: 60_000 },
  async () => {
    const service = await startZooGlassSession({ views });
    const clients: Awaited<ReturnType<typeof liveClient>>[] = [];

    try {
      for (const path of ["/events", "/views/live", "/views/live"]) {
        clients.push(await liveClient(service.baseUrl, path));
      }

      const [source, healthy, invalid] = clients;

      await healthy.subscription("bus");
      assert.deepEqual((await healthy.next()).data, {});
      for (const [index, [request, error]] of invalidRequests.entries()) {
        invalid.socket.send(request);

        assert.deepEqual(
          await invalid.next(),
          { type: "error", message: error },
          request,
        );
        await source.send(positionEvent("bus", index + 1));

        assert.equal((await healthy.next()).data?.position.sequence, index + 1);
      }
      // The same connection remains usable after rejection; a second subscribe
      // acknowledges and snapshots again but must not duplicate future fanout.
      await invalid.subscription("bus");
      await invalid.next();
      await invalid.subscription("bus");
      await invalid.next();
      await source.send(positionEvent("bus", 100));

      assert.equal((await invalid.next()).data?.position.sequence, 100);
      assert.equal((await healthy.next()).data?.position.sequence, 100);
      await invalid.subscription("bus", "unsubscribe");
      await invalid.subscription("bus", "unsubscribe");
      await source.send(positionEvent("bus", 101));

      assert.equal((await healthy.next()).data?.position.sequence, 101);
      await invalid.subscription("bus");

      assert.equal((await invalid.next()).data?.position.sequence, 101);
    } finally {
      try {
        await Promise.all(clients.map((client) => client.close()));
      } finally {
        await service.close();
      }
    }
  },
);

test(
  "invalid source events are ignored and a same-source barrier proves processing continued",
  { timeout: 60_000 },
  async () => {
    const service = await startZooGlassSession({ views });
    const clients: Awaited<ReturnType<typeof liveClient>>[] = [];

    try {
      const source = await liveClient(service.baseUrl, "/events");

      clients.push(source);

      const viewer = await liveClient(service.baseUrl);

      clients.push(viewer);
      await viewer.subscription("barrier");
      assert.deepEqual((await viewer.next()).data, {});
      await source.send(positionEvent("target", 1));

      const validEvent = positionEvent("target", 999);
      const invalidEvents = [
        "{",
        ...[
          null,
          [],
          {},
          ...["sourceId", "type", "sourceEntityId", "epoch"].flatMap((field) =>
            [undefined, null, 42, " "].map((value) => ({
              ...validEvent,
              [field]: value,
            })),
          ),
          ...[
            undefined,
            null,
            0,
            -1,
            1.5,
            "999",
            Number.MAX_SAFE_INTEGER + 1,
          ].map((publicationSequence) => ({
            ...validEvent,
            publicationSequence,
          })),
          ...[null, [], 1, "text"].map((payload) => ({
            ...validEvent,
            payload,
          })),
        ].map((message) => JSON.stringify(message)),
      ];

      for (const [index, message] of invalidEvents.entries()) {
        source.socket.send(message);
        await source.send(positionEvent("barrier", index + 1));

        assert.equal((await viewer.next()).data?.position.sequence, index + 1);

        const response = await fetch(
          service.baseUrl + "/views/position/target",
          { signal: AbortSignal.timeout(5000) },
        );

        assert.equal(response.status, 200);
        assert.deepEqual(
          (await response.json()).data,
          { position: { sequence: 1, padding: "" } },
          message,
        );
      }
      await source.send(positionEvent("target", 2));
      await source.send(positionEvent("barrier", 100));

      assert.equal((await viewer.next()).data?.position.sequence, 100);
      await viewer.subscription("target");

      assert.equal((await viewer.next()).data?.position.sequence, 2);
    } finally {
      try {
        await Promise.all(clients.map((client) => client.close()));
      } finally {
        await service.close();
      }
    }
  },
);

test(
  "rejected view definitions leave no partial registration and can be corrected",
  { timeout: 60_000 },
  async () => {
    const service = await startZooGlassSession({ views });
    const clients: Awaited<ReturnType<typeof liveClient>>[] = [];

    try {
      const source = await liveClient(service.baseUrl, "/events");

      clients.push(source);

      const viewer = await liveClient(service.baseUrl);

      clients.push(viewer);
      await viewer.subscription("barrier");
      assert.deepEqual((await viewer.next()).data, {});

      const definition = {
        id: "position",
        fields: {
          position: {
            sourceId: "feed",
            type: "position",
            mode: "latestBySequence",
          },
        },
      };
      const definitions = [
        { fields: {} },
        { fields: { position: [] } },
        { fields: { position: null } },
        {
          fields: { position: { sourceId: "feed", type: "", mode: "arrival" } },
        },
        {
          fields: {
            position: {
              sourceId: "unknown",
              type: "position",
              mode: "arrival",
            },
          },
        },
        {
          fields: {
            position: { sourceId: "feed", type: "position", mode: "unknown" },
          },
        },
        { fields: { position: { inputs: [], mode: "arrival" } } },
      ];

      const define = (body: unknown) =>
        fetch(service.baseUrl + "/views", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });

      for (const [index, invalid] of definitions.entries()) {
        const id = `corrected-${index}`;
        const entity = `item-${index}`;

        assert.equal(
          (await define({ ...definition, id, ...invalid })).status,
          400,
        );
        await source.send(positionEvent(entity, 1));
        await source.send(positionEvent("barrier", index + 1));

        assert.equal((await viewer.next()).data?.position.sequence, index + 1);
        assert.equal(
          (
            await fetch(`${service.baseUrl}/views/${id}/${entity}`, {
              signal: AbortSignal.timeout(5000),
            })
          ).status,
          404,
        );
        assert.equal((await define({ ...definition, id })).status, 201);
        assert.equal((await define({ ...definition, id })).status, 409);
        await viewer.send({
          action: "subscribe",
          viewId: id,
          entityId: entity,
        });

        assert.deepEqual(await viewer.next(), {
          type: "subscribed",
          recovery: "freshSnapshot",
          viewId: id,
          entityId: entity,
        });
        assert.deepEqual((await viewer.next()).data, {});
        await source.send(positionEvent(entity, 2));

        const update = await viewer.next();

        assert.equal(update.viewId, id);
        assert.equal(update.data?.position.sequence, 2);
      }
    } finally {
      try {
        await Promise.all(clients.map((client) => client.close()));
      } finally {
        await service.close();
      }
    }
  },
);

test("unsubscribe preserves an unchecked baseline for the Node viewer", async () => {
  const service = await startZooGlassSession({ views });
  const viewer = createNodeClientExecutor(
    service.baseUrl.replace("http:", "ws:") + "/views/live",
  );
  const client = {
    clientId: "viewer",
    clientName: "Viewer",
    simulationTime: 0,
  };
  const pair = { ...client, viewId: "position", entityId: "bus" };
  try {
    await viewer.execute(
      { ...client, kind: "client-state", state: "connected" },
      service.signal,
    );
    for (const action of ["subscribe", "unsubscribe"] as const) {
      await viewer.execute(
        { ...pair, kind: "client-subscription", action },
        service.signal,
      );
    }
    await viewer.execute(
      { ...pair, kind: "client-view-check", expected: {} },
      service.signal,
    );
  } finally {
    try {
      await viewer.close();
    } finally {
      await service.close();
    }
  }
});
