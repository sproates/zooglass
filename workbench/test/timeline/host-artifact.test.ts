import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { Bridge } from "../../src/timeline/bridge.js";
import { requireHostArtifact } from "../../src/timeline/host-artifact.js";

const jarLauncher = "org.springframework.boot.loader.launch.JarLauncher";
const host = "io.zooglass.simulation.TimelineHost";
const service = "io.zooglass.ZooGlassApplication";
const header = `Manifest-Version: 1.0\r\nMain-Class: ${jarLauncher}\r\n`;
const manifestPath = "META-INF/MANIFEST.MF";
const archive = (manifest: string) =>
  Buffer.from(zipSync({ [manifestPath]: Buffer.from(manifest) }));
const rejection = /Expected the ZooGlass simulation host JAR/;

test("host admission unfolds headers and reads only the manifest main section", async () => {
  await requireHostArtifact(
    archive(
      `${header}start-class: io.zooglass.simulation.\r\n TimelineHost\r\n\r\n` +
        `Name: other-section\r\nStart-Class: ${service}\r\n\r\n`,
    ),
  );
  await assert.rejects(
    () =>
      requireHostArtifact(
        archive(
          `${header}\r\nName: only-in-section\r\nStart-Class: ${host}\r\n\r\n`,
        ),
      ),
    /Expected the ZooGlass simulation host JAR/,
  );
});

test("host admission rejects ambiguous, oversized and externally extensible manifests", async () => {
  const valid = `${header}Start-Class: ${host}\r\n`;
  for (const manifest of [
    `${valid}start-class: ${host}\r\n\r\n`,
    `${valid}Class-Path: other.jar\r\n\r\n`,
    `${valid}Launcher-Agent-Class: example.Agent\r\n\r\n`,
    `${valid}Description: ${"x".repeat(64 * 1024)}\r\n\r\n`,
  ]) {
    await assert.rejects(
      () => requireHostArtifact(archive(manifest)),
      /Expected the ZooGlass simulation host JAR/,
    );
  }
  await assert.rejects(
    () =>
      requireHostArtifact(
        Buffer.from(
          zipSync({
            [manifestPath]: Buffer.from(`${valid}\r\n`),
            [manifestPath.toLowerCase()]: Buffer.from(`${valid}\r\n`),
          }),
        ),
      ),
    /Expected the ZooGlass simulation host JAR/,
  );
});

test("host admission rejects malformed directory metadata", async () => {
  const valid = Buffer.from(`${header}Start-Class: ${host}\r\n\r\n`);
  const bytes = Buffer.from(
    zipSync({
      [manifestPath]: valid,
      [manifestPath.toLowerCase()]: valid,
    }),
  );
  const end = bytes.length - 22;
  // One reported entry cannot hide the second manifest from the directory scan.
  bytes.writeUInt16LE(1, end + 8);
  await assert.rejects(requireHostArtifact(bytes), rejection);
  bytes.writeUInt16LE(1, end + 10);
  await assert.rejects(requireHostArtifact(bytes), rejection);

  // Maven's ordinary ZIP32 layout cannot carry a ZIP64 directory locator.
  const zip64 = Buffer.concat([
    bytes.subarray(0, end),
    Buffer.alloc(20),
    bytes.subarray(end),
  ]);
  zip64.writeUInt32LE(0x07064b50, end);
  await assert.rejects(requireHostArtifact(zip64), rejection);
});

test("host admission checks the manifest's inflated size and integrity", async () => {
  const valid = `${header}Start-Class: ${host}\r\n\r\n`;
  const wrongSize = archive(valid);
  const directory = wrongSize.readUInt32LE(wrongSize.length - 6);
  wrongSize.writeUInt32LE(Buffer.byteLength(valid) - 1, directory + 24);
  await assert.rejects(requireHostArtifact(wrongSize), rejection);

  const wrongCrc = archive(valid);
  wrongCrc.writeUInt32LE(0, directory + 16);
  await assert.rejects(requireHostArtifact(wrongCrc), rejection);
});

test("the bridge rejects a production entry point before spawning Java", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "timeline-host-admission-"));
  const wrongJar = join(directory, "service.jar");
  const spawn = context.mock.method(childProcess, "spawn", () => {
    assert.fail("Artifact admission must precede process launch");
  });
  syncBuiltinESMExports();
  try {
    await writeFile(
      wrongJar,
      archive(`${header}Start-Class: ${service}\r\n\r\n`),
    );
    await assert.rejects(
      Bridge.open(wrongJar),
      /Expected the ZooGlass simulation host JAR/,
    );
    assert.equal(spawn.mock.callCount(), 0);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});
