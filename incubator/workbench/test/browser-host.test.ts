import assert from "node:assert/strict";
import test from "node:test";
import { get } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { startBrowserHost } from "../src/browser-host.js";

const application = {
  clientId: "inventory-reader",
  assets: new Map<string, readonly [string, Buffer]>([
    [
      "/",
      [
        "text/html; charset=utf-8",
        Buffer.from("<title>Inventory fixture</title>"),
      ],
    ],
  ]),
};

async function rejected(url: string, origin?: string) {
  const socket = new WebSocket(url, { origin });
  const result = new Promise<number>((resolve) =>
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode!);
      response.destroy();
      socket.terminate();
    }),
  );

  socket.on("error", () => {});

  return result;
}

test("host rejects foreign/missing origins and invalid routes; timeout and close release its port", async () => {
  const host = await startBrowserHost("http://127.0.0.1:1", { application });

  try {
    assert.equal(host.clientId, "inventory-reader");
    assert.equal(
      await (await fetch(host.origin)).text(),
      "<title>Inventory fixture</title>",
    );
    assert.equal((await fetch(host.origin + "/vehicle-client.js")).status, 404);

    const control = host.origin.replace("http:", "ws:") + "/control";

    assert.equal(await rejected(control, "http://foreign.invalid"), 403);
    assert.equal(await rejected(control), 403);
    assert.equal(
      await rejected(
        host.origin.replace("http:", "ws:") + "/views/live?route=wrong",
        host.origin,
      ),
      403,
    );
    assert.equal((await fetch(host.origin + "/../package.json")).status, 404);
    assert.equal(
      await new Promise<number | undefined>((resolve, reject) => {
        get(
          host.origin,
          { headers: { Host: "foreign.invalid" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        ).on("error", reject);
      }),
      403,
    );
    await assert.rejects(
      host.waitForReady(new AbortController().signal, 30),
      /timeout/i,
    );
  } finally {
    await host.close();
    await host.close();
  }

  await assert.rejects(fetch(host.origin));
});

test("registration validates run identity and token, rejects duplicate clients, and reports control loss", async () => {
  const host = await startBrowserHost("http://127.0.0.1:1", { application });
  const parameters = new URLSearchParams(new URL(host.pageUrl).hash.slice(1));
  const url = host.origin.replace("http:", "ws:") + "/control";
  const register = {
    type: "register",
    protocolVersion: 1,
    runId: host.runId,
    clientId: host.clientId,
    token: parameters.get("token"),
  };

  try {
    for (const bad of [
      { token: "wrong" },
      { runId: "old-run" },
      { clientId: "another-client" },
      { protocolVersion: 2 },
    ]) {
      const socket = new WebSocket(url, { origin: host.origin });

      await once(socket, "open");
      socket.send(JSON.stringify({ ...register, ...bad }));

      const [code] = await once(socket, "close");

      assert.equal(code, 1008);
    }

    const socket = new WebSocket(url, { origin: host.origin });

    await once(socket, "open");
    socket.send(JSON.stringify(register));

    const [response] = await once(socket, "message");
    const registrationReply = JSON.parse(response.toString());

    assert.equal(registrationReply.type, "registered");
    socket.send(
      JSON.stringify({
        type: "ready",
        runId: host.runId,
        clientId: host.clientId,
      }),
    );
    await host.waitForReady(new AbortController().signal);

    assert.equal(await rejected(url, host.origin), 403);

    const dataUrl =
      host.origin.replace("http:", "ws:") + registrationReply.dataPath;

    assert.equal(await rejected(dataUrl, "http://foreign.invalid"), 403);
    assert.equal(await rejected(dataUrl, host.origin), 502);
    assert.equal(host.signal.aborted, false);

    const aborted = once(host.signal, "abort");

    socket.terminate();
    await aborted;

    assert.match(host.signal.reason.message, /control connection lost/);
  } finally {
    await host.close();
  }
});
