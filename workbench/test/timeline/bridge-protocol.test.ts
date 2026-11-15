import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { zipSync } from "fflate";
import { Bridge } from "../../src/timeline/bridge.js";

function frame(value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

for (const corruption of ["effect", "utf8"] as const) {
  test(`bridge rejects malformed ${corruption} before exposing a response`, async (context) => {
    // Only the pipe is simulated. Admission still reads a real, minimal JAR manifest.
    const directory = await mkdtemp(join(tmpdir(), "timeline-pipe-"));
    const jar = join(directory, "host.jar");
    const archive = zipSync({
      "META-INF/MANIFEST.MF": Buffer.from(
        "Manifest-Version: 1.0\r\n" +
          "Main-Class: org.springframework.boot.loader.launch.JarLauncher\r\n" +
          "Start-Class: io.zooglass.simulation.TimelineHost\r\n\r\n",
      ),
    });
    await writeFile(jar, archive);
    const artifact = createHash("sha256").update(archive).digest("hex");
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        child.emit("close", 0);
        return true;
      },
    });
    const reply = frame({
      turnId: 0,
      runtimeGeneration: 1,
      timeMs: 0,
      pendingTasks: 1,
      heldFrames: 0,
      effects:
        corruption === "effect"
          ? [
              {
                kind: "schedule",
                task: "not-an-integer",
                at: 0,
                phase: 1,
                taskKind: "alarm",
              },
            ]
          : [{ kind: "state", wire: '{"text":"é"}' }],
    });
    if (corruption === "utf8") {
      const at = reply.indexOf(Buffer.from("é"));
      assert.ok(at >= 0);
      reply[at + 1] = 0x28; // C3 28 cannot encode a Unicode character.
    }
    child.stdin.once("data", () => child.stdout.write(reply));
    const spawn = context.mock.method(childProcess, "spawn", () => {
      queueMicrotask(() =>
        child.stdout.write(
          frame({
            protocol: 1,
            fixture: "timeline-proof-v1",
            artifact,
            frameCap: 16 * 1024 * 1024,
            storage: ["memory"],
            protectedAccess: false,
          }),
        ),
      );
      return child;
    });
    syncBuiltinESMExports();
    let bridge: Bridge | undefined;
    try {
      ({ bridge } = await Bridge.open(jar));
      await assert.rejects(
        bridge.command(0, { op: "initialize", policy: "coalesceLatestState" }),
        corruption === "effect"
          ? /Invalid host protocol: response.effects\[0\].task/
          : /encoded data.*valid/i,
      );
    } finally {
      await bridge?.close();
      spawn.mock.restore();
      syncBuiltinESMExports();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
