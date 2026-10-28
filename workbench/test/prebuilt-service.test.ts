import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, copyFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import WebSocket from "ws";
import {
  startZooGlassSession,
  type ZooGlassSession,
} from "../src/service/zooglass-session.js";

// An artifact-only directory has no Maven wrapper, pom or source tree to build.
// Spaces in its path also exercise direct Java argument handling on Windows.
test(
  "concurrent prebuilt sessions isolate state and restart without build outputs",
  { timeout: 60_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "workbench prebuilt "));
    const sessions: ZooGlassSession[] = [];
    const sockets: WebSocket[] = [];
    t.after(async () => {
      for (const socket of sockets) socket.terminate();
      await Promise.allSettled(sessions.map((session) => session.close()));
      await rm(directory, { recursive: true, force: true });
    });
    await mkdir(join(directory, "target"));
    const artifact = join(directory, "target", "zooglass.jar");
    await copyFile(
      new URL("../../zooglass/target/zooglass.jar", import.meta.url),
      artifact,
    );
    const before = await stat(artifact);
    const views = (field: string) => [
      {
        id: "isolated",
        fields: { [field]: [{ sourceId: "feed", type: "updated" }] },
      },
    ];
    const start = async (field: string) => {
      const session = await startZooGlassSession({
        serviceDirectory: directory,
        views: views(field),
      });
      sessions.push(session);
      return session;
    };
    const starts = await Promise.allSettled([start("first"), start("second")]);
    const [first, second] = starts.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    assert.notEqual(first.baseUrl, second.baseUrl);

    const sendAndRead = async (baseUrl: string, field: string) => {
      const socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/events`);
      sockets.push(socket);
      await once(socket, "open");
      socket.send(
        JSON.stringify({
          sourceId: "feed",
          type: "updated",
          entityId: "item",
          payload: { value: 42 },
        }),
      );
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const response = await fetch(`${baseUrl}/views/isolated/item`);
        if (response.ok) {
          const snapshot = (await response.json()) as { data: unknown };
          assert.deepEqual(snapshot.data, { [field]: { value: 42 } });
          socket.close();
          return;
        }
        await delay(20);
      }
      assert.fail("The source event was not projected before the deadline.");
    };

    await sendAndRead(first.baseUrl, "first");
    assert.equal(
      (await fetch(`${second.baseUrl}/views/isolated/item`)).status,
      404,
    );
    await sendAndRead(second.baseUrl, "second");
    await first.close();
    const replacement = await start("replacement");
    assert.equal(
      (await fetch(`${replacement.baseUrl}/views/isolated/item`)).status,
      404,
    );
    await sendAndRead(replacement.baseUrl, "replacement");
    await Promise.all([second.close(), replacement.close()]);

    assert.deepEqual(await readdir(directory), ["target"]);
    assert.deepEqual(await readdir(join(directory, "target")), [
      "zooglass.jar",
    ]);
    const after = await stat(artifact);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  },
);
