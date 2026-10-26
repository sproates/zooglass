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
      for (const path of ["/events", "/views/live", "/views/live"])
        clients.push(await liveClient(service.baseUrl, path));

      const [source, healthy, invalid] = clients;

      await healthy.subscription("bus");
      for (const [index, [request, error]] of invalidRequests.entries()) {
        invalid.socket.send(request);

        assert.deepEqual(
          await invalid.next(),
          { type: "error", message: error },
          request,
        );
        await source.send(positionEvent("bus", index));

        assert.equal((await healthy.next()).data?.position.sequence, index);
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
      await source.send(positionEvent("target", 1));

      const validEvent = positionEvent("target", 999);
      const invalidEvents = [
        "{",
        ...[
          null,
          [],
          {},
          ...["sourceId", "type", "entityId"].flatMap((field) =>
            [undefined, null, 42, " "].map((value) => ({
              ...validEvent,
              [field]: value,
            })),
          ),
          ...[
            null,
            [],
            1,
            "text",
            {},
            { sequence: "999" },
            { sequence: null },
          ].map((payload) => ({ ...validEvent, payload })),
        ].map((message) => JSON.stringify(message)),
      ];

      for (const [index, message] of invalidEvents.entries()) {
        source.socket.send(message);
        await source.send(positionEvent("barrier", index));

        assert.equal((await viewer.next()).data?.position.sequence, index);

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

      const definitions = [
        { fields: {} },
        { fields: { position: [] } },
        { fields: { position: [null] } },
        { fields: { position: [{ sourceId: "feed", type: "" }] } },
        {
          ordering: {
            unknown: { mode: "latestBySequence", sequenceField: "sequence" },
          },
        },
        {
          ordering: {
            position: { mode: "unknown", sequenceField: "sequence" },
          },
        },
        {
          ordering: {
            position: { mode: "latestBySequence", sequenceField: "" },
          },
        },
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
          (await define({ ...views[0], id, ...invalid })).status,
          400,
        );
        await source.send(positionEvent(entity, 1));
        await source.send(positionEvent("barrier", index));

        assert.equal((await viewer.next()).data?.position.sequence, index);
        assert.equal(
          (
            await fetch(`${service.baseUrl}/views/${id}/${entity}`, {
              signal: AbortSignal.timeout(5000),
            })
          ).status,
          404,
        );
        assert.equal((await define({ ...views[0], id })).status, 201);
        assert.equal((await define({ ...views[0], id })).status, 409);
        await viewer.send({
          action: "subscribe",
          viewId: id,
          entityId: entity,
        });

        assert.deepEqual(await viewer.next(), {
          type: "subscribed",
          viewId: id,
          entityId: entity,
        });
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
