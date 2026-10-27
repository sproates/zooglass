import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { startExternalBrowserHost } from "../../src/browser/external-browser-host.js";

async function register(origin: string, pair: string, acknowledge = true) {
  const socket = new WebSocket(origin.replace("http:", "ws:") + "/control", {
    origin,
  });
  socket.on("error", () => {});
  await once(socket, "open");
  const next = once(socket, "message");
  socket.send(JSON.stringify({ type: "register", protocolVersion: 1, pair }));
  const [data] = await next;
  const binding = JSON.parse(data.toString());
  if (acknowledge)
    socket.send(
      JSON.stringify({
        type: "ready",
        runId: binding.runId,
        clientId: binding.clientId,
      }),
    );
  return { socket, binding };
}

async function ready(
  host: Awaited<ReturnType<typeof startExternalBrowserHost>>,
  id: string,
) {
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      return host.viewer(id);
    } catch {
      assert.ok(Date.now() < deadline, "viewer readiness deadline");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

test(
  "external boundary rejects wrong Origin/Host, reused invitations and observer/obsolete commands",
  { timeout: 15_000 },
  async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const host = await startExternalBrowserHost({
      application: { clientId: "unused", assets: new Map() },
      bindAddress: "127.0.0.1",
      onReady: async () => {},
      onControllerLost() {},
      onControl: async () => {
        calls++;
        entered();
        await hold;
      },
    });
    const sockets: WebSocket[] = [];
    try {
      await host.replaceRun("http://127.0.0.1:1");
      for (const headers of [
        { Origin: "http://elsewhere.invalid" },
        { Origin: host.origin, Host: "elsewhere.invalid" },
        {},
      ]) {
        const socket = new WebSocket(
          host.origin.replace("http:", "ws:") + "/control",
          { headers },
        );
        sockets.push(socket);
        socket.on("error", () => {});
        const status = await new Promise<number | undefined>((resolve) =>
          socket.once("unexpected-response", (_request, response) => {
            resolve(response.statusCode);
            response.destroy();
          }),
        );
        assert.equal(status, 403);
        socket.terminate();
      }
      const ownerLink = host.pair("Owner", true);
      const guestLink = host.pair("Observer");
      const owner = await register(
        host.origin,
        new URLSearchParams(new URL(ownerLink.url).hash.slice(1)).get("pair")!,
      );
      const guest = await register(
        host.origin,
        new URLSearchParams(new URL(guestLink.url).hash.slice(1)).get("pair")!,
      );
      sockets.push(owner.socket, guest.socket);
      await ready(host, ownerLink.id);
      await ready(host, guestLink.id);
      const guestMessages: Record<string, unknown>[] = [];
      guest.socket.on("message", (data) =>
        guestMessages.push(JSON.parse(data.toString())),
      );

      guest.socket.send(
        JSON.stringify({
          type: "control-request",
          action: "step",
          runId: guest.binding.runId,
          clientId: guest.binding.clientId,
        }),
      );
      const rejectedBy = Date.now() + 2000;
      while (
        !guestMessages.some((message) => message.type === "control-rejected") &&
        Date.now() < rejectedBy
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(calls, 0);
      assert.ok(
        guestMessages.some((message) => message.type === "control-rejected"),
      );

      const request = {
        type: "control-request",
        action: "step",
        runId: owner.binding.runId,
        clientId: owner.binding.clientId,
      };
      owner.socket.send(JSON.stringify(request));
      await started;
      owner.socket.send(JSON.stringify(request));
      owner.socket.send(
        JSON.stringify({
          ...request,
          type: "observation",
          event: "opened",
          observationIndex: 1,
          connectionGeneration: 1,
        }),
      );
      await host
        .viewer(ownerLink.id)
        .observations.wait("opened", 0, new AbortController().signal, 2000);
      const errors: Record<string, unknown>[] = [];
      owner.socket.on("message", (data) =>
        errors.push(JSON.parse(data.toString())),
      );
      host.transfer(guestLink.id);
      release();
      const deadline = Date.now() + 2000;
      while (
        !errors.some((message) => message.type === "control-rejected") &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(errors.some((message) => message.type === "control-rejected"));
      assert.equal(calls, 1, "a queued command loses authority on handover");

      const duplicate = new WebSocket(
        host.origin.replace("http:", "ws:") + "/control",
        { origin: host.origin },
      );
      duplicate.on("error", () => {});
      sockets.push(duplicate);
      await once(duplicate, "open");
      const closed = once(duplicate, "close");
      duplicate.send(
        JSON.stringify({
          type: "register",
          protocolVersion: 1,
          pair: new URLSearchParams(new URL(ownerLink.url).hash.slice(1)).get(
            "pair",
          ),
        }),
      );
      assert.equal((await closed)[0], 1008);
    } finally {
      release();
      for (const socket of sockets) socket.terminate();
      await host.close();
    }
  },
);

test(
  "an unready observer is detached without failing the host or another viewer",
  { timeout: 5000 },
  async () => {
    const host = await startExternalBrowserHost({
      application: { clientId: "unused", assets: new Map() },
      bindAddress: "127.0.0.1",
      readinessTimeoutMs: 500,
      onReady: async () => {},
      onControl: async () => {},
      onControllerLost() {},
    });
    try {
      await host.replaceRun("http://127.0.0.1:1");
      const next = host.pair("Ready");
      const good = await register(
        host.origin,
        new URLSearchParams(new URL(next.url).hash.slice(1)).get("pair")!,
      );
      await ready(host, next.id);
      const link = host.pair("Unready");
      const viewer = await register(
        host.origin,
        new URLSearchParams(new URL(link.url).hash.slice(1)).get("pair")!,
        false,
      );
      await once(viewer.socket, "close");
      assert.equal(
        host.list().find((viewer) => viewer.id === link.id)!.connected,
        false,
      );
      assert.equal(host.viewer(next.id).signal.aborted, false);
      assert.equal(host.signal.aborted, false);
      good.socket.terminate();
    } finally {
      await host.close();
    }
  },
);
