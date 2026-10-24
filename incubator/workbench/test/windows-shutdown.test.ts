import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { startZooGlassSession } from "../src/zooglass-session.js";

// Exercise Windows shutdown decisions on every CI host. These mocks do not
// establish how a particular Windows console process responds to taskkill.
for (const outcome of [
  "clean exit",
  "still running",
  "request refused",
] as const) {
  test(`Windows shutdown: ${outcome}`, async (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const child = Object.assign(new EventEmitter(), { pid: 12345 });
    const requests: string[][] = [];
    let closed = false;
    let firstRequestAt = 0;
    const finish = () => {
      closed = true;
      child.emit("close", 0, null);
    };
    t.after(() => {
      Object.defineProperty(process, "platform", platform);
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    Object.defineProperty(process, "platform", { value: "win32" });
    t.mock.method(
      childProcess,
      "spawn",
      () => child as unknown as ChildProcess,
    );
    t.mock.method(
      childProcess,
      "execFile",
      (
        command: string,
        args: string[],
        callback: (error: Error | null) => void,
      ) => {
        assert.equal(command, "taskkill");
        requests.push(args);
        if (requests.length === 1) {
          firstRequestAt = performance.now();
          assert.deepEqual(args, ["/PID", "12345", "/T"]);
          callback(
            outcome === "request refused" ? new Error("Requires /F") : null,
          );
          if (outcome === "clean exit") setImmediate(finish);
        } else {
          assert.ok(performance.now() - firstRequestAt >= 40);
          assert.deepEqual(args, ["/PID", "12345", "/T", "/F"]);
          callback(null);
          setImmediate(finish);
        }
        return child;
      },
    );
    t.mock.method(globalThis, "fetch", async () => new Response("{}"));
    syncBuiltinESMExports();
    const session = await startZooGlassSession({ shutdownTimeoutMs: 50 });
    await session.close();
    assert.equal(closed, true, "close must await child completion");
    assert.equal(requests.length, outcome === "clean exit" ? 1 : 2);
    await session.close();
    assert.equal(requests.length, outcome === "clean exit" ? 1 : 2);
  });
}
