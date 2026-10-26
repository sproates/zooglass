import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import test, { type TestContext } from "node:test";
import { openScenarioSession } from "../src/execution/scenario-session.js";

interface RecordedRequest {
  method: string;
  path: string;
  type: string;
  body: unknown;
}

async function sessionAt(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();

  assert.ok(address && typeof address !== "string");

  const session = await openScenarioSession(
    {
      name: "HTTP contract",
      sources: [],
      clients: [],
      views: [],
      timeline: [],
    },
    `http://127.0.0.1:${address.port}`,
  );

  t.after(async () => {
    await session.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return session;
}

const check = {
  kind: "view-check" as const,
  simulationTime: 0,
  viewId: "view /?",
  entityId: "entity /#",
  expected: { value: 42 },
};

test("HTTP checks encode identifiers and poll until the expected data arrives", async (t) => {
  const urls: string[] = [];
  const responses = [
    { status: 503, body: {} },
    { status: 200, body: {} },
    { status: 200, body: { data: { value: 41 } } },
    { status: 200, body: { data: { value: 42 } } },
  ];
  const session = await sessionAt(t, (req, res) => {
    urls.push(req.url!);

    const response = responses.shift();

    res.writeHead(response?.status ?? 500, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify(response?.body));
  });

  await session.execute(check);

  assert.deepEqual(urls, Array(4).fill("/views/view%20%2F%3F/entity%20%2F%23"));
});

test("HTTP absence accepts 404 but rejects a present view immediately", async (t) => {
  let requests = 0;
  const session = await sessionAt(t, (_req, res) => {
    res.writeHead(++requests === 1 ? 404 : 200);
    res.end("{}");
  });

  await session.execute({ ...check, expected: null });

  await assert.rejects(
    session.execute({ ...check, expected: null }),
    /to be absent, but it was present/,
  );
  assert.equal(requests, 2);
});

test("malformed HTTP JSON fails the action and a later action can still succeed", async (t) => {
  let requests = 0;
  const session = await sessionAt(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(++requests === 1 ? "not json" : '{"data":{"value":42}}');
  });

  await assert.rejects(session.execute(check), SyntaxError);
  await session.execute(check);

  assert.equal(requests, 2);
});

test("view definition sends only its definition and requires HTTP 201", async (t) => {
  const requests: RecordedRequest[] = [];
  const session = await sessionAt(t, (req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({
        method: req.method!,
        path: req.url!,
        type: req.headers["content-type"]!,
        body: JSON.parse(body),
      });
      res.writeHead(requests.length === 1 ? 201 : 409);
      res.end();
    });
  });
  const definition = {
    id: "position",
    fields: { value: [{ sourceId: "feed", type: "changed" }] },
    ordering: {
      value: { mode: "latestBySequence" as const, sequenceField: "sequence" },
    },
  };
  const entry = {
    kind: "view-definition" as const,
    simulationTime: 20,
    ...definition,
  };

  await session.execute(entry);

  await assert.rejects(session.execute(entry), {
    message: "Could not define view position: ZooGlass returned HTTP 409.",
  });
  assert.deepEqual(
    requests,
    Array(2).fill({
      method: "POST",
      path: "/views",
      type: "application/json",
      body: definition,
    }),
  );
});
