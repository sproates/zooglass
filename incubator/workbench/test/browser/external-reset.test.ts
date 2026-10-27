import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { startExternalBrowserHost } from "../../src/browser/external-browser-host.js";

test(
  "Reset during viewer setup cancels the old setup without detaching the replacement",
  { timeout: 5000 },
  async () => {
    let starting!: () => void;
    const started = new Promise<void>((resolve) => {
      starting = resolve;
    });
    let first = true;
    const host = await startExternalBrowserHost({
      application: { clientId: "unused", assets: new Map() },
      bindAddress: "127.0.0.1",
      onReady: async (run) => {
        if (!first) return;
        first = false;
        starting();
        await new Promise<void>((_resolve, reject) =>
          run.signal.addEventListener(
            "abort",
            () => reject(run.signal.reason),
            { once: true },
          ),
        );
      },
      onControl: async () => {},
      onControllerLost() {},
    });
    let socket: WebSocket | undefined;
    try {
      await host.replaceRun("http://127.0.0.1:1");
      const invitation = host.pair("Reader");
      socket = new WebSocket(host.origin.replace("http:", "ws:") + "/control", {
        origin: host.origin,
      });
      socket.on("error", () => {});
      const ids: string[] = [];
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (["registered", "run-changed"].includes(message.type)) {
          ids.push(message.runId);
          socket!.send(
            JSON.stringify({
              type: "ready",
              runId: message.runId,
              clientId: message.clientId,
            }),
          );
        }
      });
      await once(socket, "open");
      socket.send(
        JSON.stringify({
          type: "register",
          protocolVersion: 1,
          pair: new URLSearchParams(new URL(invitation.url).hash.slice(1)).get(
            "pair",
          ),
        }),
      );
      await started;
      await host.replaceRun("http://127.0.0.1:2");
      assert.equal(ids.length, 2);
      assert.notEqual(ids[0], ids[1]);
      assert.equal(host.list()[0].connected, true);
      assert.equal(host.viewer(invitation.id).runId, ids[1]);
    } finally {
      socket?.terminate();
      await host.close();
    }
  },
);
