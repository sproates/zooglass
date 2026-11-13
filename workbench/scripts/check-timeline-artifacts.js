import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../../zooglass", import.meta.url)),
);
const service = join(root, "target/zooglass.jar");
const library = join(root, "target/zooglass-runtime.jar");
const host = join(root, "simulation-host/target/zooglass-simulation.jar");
const list = (path) =>
  execFileSync("jar", ["tf", path], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .trim()
    .split(/\r?\n/);
const forbidden =
  /^io\/zooglass\/(simulation\/|runtime\/(TimelineRuntime|TimelineProfile|ControlledReceiptClock|ControlledAlarmScheduler)|delivery\/TimelineDelivery)/;
for (const path of [service, library]) {
  const entries = list(path);
  assert.ok(
    !entries.some((name) =>
      forbidden.test(name.replace(/^BOOT-INF\/classes\//, "")),
    ),
    "Production artifacts must not contain simulation classes",
  );
  assert.ok(
    !entries.some((name) => name.includes("zooglass-simulation")),
    "Production must not depend on host",
  );
}
const entries = list(host);
assert.ok(
  entries.includes(
    "BOOT-INF/classes/io/zooglass/simulation/TimelineHost.class",
  ),
);
assert.ok(
  entries.includes(
    "BOOT-INF/classes/io/zooglass/runtime/ControlledReceiptClock.class",
  ),
);
assert.ok(
  !entries.includes(
    "BOOT-INF/classes/io/zooglass/runtime/ViewCoordinator.class",
  ),
  "Host must use shared runtime dependency, not duplicate implementation",
);
const embedded = entries.filter((name) =>
  /^BOOT-INF\/lib\/zooglass-[\w.-]+-runtime\.jar$/.test(name),
);
assert.equal(embedded.length, 1, "Exactly one ordinary runtime dependency");
const directory = await mkdtemp(join(tmpdir(), "zooglass-artifacts-"));
try {
  execFileSync("jar", ["xf", host, embedded[0], "META-INF/MANIFEST.MF"], {
    cwd: directory,
  });
  const manifest = await readFile(
    join(directory, "META-INF/MANIFEST.MF"),
    "utf8",
  );
  assert.match(
    manifest,
    /^Main-Class: org\.springframework\.boot\.loader\.launch\.JarLauncher\r?$/m,
  );
  assert.match(
    manifest,
    /^Start-Class: io\.zooglass\.simulation\.TimelineHost\r?$/m,
  );
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    digest(await readFile(join(directory, embedded[0]))),
    digest(await readFile(library)),
    "Host embeds freshly prepared runtime",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log(
  "Service/runtime exclude simulation; host embeds the matching runtime library.",
);
