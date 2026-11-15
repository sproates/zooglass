import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve("../zooglass");
const check = (directory: string) =>
  spawnSync(
    process.execPath,
    ["scripts/check-timeline-artifacts.js", directory],
    { encoding: "utf8" },
  );

test("prepared production and simulation artifacts have separate contents and matching dependency", () => {
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
});

test("artifact gate rejects leaked host classes and a stale embedded runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timeline-packaging-"));
  const host = join(
    directory,
    "simulation-host/target/zooglass-simulation.jar",
  );
  try {
    await mkdir(join(directory, "target"), { recursive: true });
    await mkdir(join(directory, "simulation-host/target"), { recursive: true });
    await cp(
      join(root, "simulation-host/target/zooglass-simulation.jar"),
      host,
    );
    await cp(
      join(root, "target/zooglass.jar"),
      join(directory, "target/zooglass.jar"),
    );
    await cp(
      join(root, "target/zooglass-runtime.jar"),
      join(directory, "target/zooglass-runtime.jar"),
    );
    // Alter only the prepared fixture archive; never compile or build Java in tests.
    await appendFile(
      join(directory, "target/zooglass-runtime.jar"),
      Buffer.from([0]),
    );
    assert.match(
      check(directory).stderr,
      /Host embeds freshly prepared runtime/,
    );
    await cp(
      join(root, "target/zooglass-runtime.jar"),
      join(directory, "target/zooglass-runtime.jar"),
    );
    const entry = "BOOT-INF/classes/io/zooglass/simulation/TimelineHost.class";
    execFileSync("jar", ["xf", host, entry], { cwd: directory });
    execFileSync("jar", ["uf", join(directory, "target/zooglass.jar"), entry], {
      cwd: directory,
    });
    assert.match(
      check(directory).stderr,
      /Production artifacts must not contain simulation classes/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
