import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { files, fixture } from "./document-fixture.js";
import {
  recordBundle,
  readBundle,
  replayBundle,
} from "../../src/timeline/artifact-bundle.js";
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ?? "../zooglass/target/zooglass.jar",
);
const cli = (...args: string[]) =>
  spawnSync(
    process.execPath,
    ["--import", "tsx", "src/timeline/bundle-cli.ts", ...args],
    { encoding: "utf8" },
  );
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("portable bundle retains lossless inputs, streamed trace and identities after originals disappear", async () => {
  const input = await files(fixture(), (s) =>
    s.replaceAll('"amount":1}', '"amount":9007199254740993}'),
  );
  const root = await mkdtemp(join(tmpdir(), "timeline-bundle-"));
  try {
    const original = join(root, "original");
    const result = await recordBundle(input.path, original, { jar });
    assert.equal(result.outcome, "passed", result.message);
    assert.equal(
      await readFile(join(original, "trace.jsonl"), "utf8"),
      result.trace,
    );
    const manifest = JSON.parse(
      await readFile(join(original, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.initialState.state, "empty");
    assert.equal(
      manifest.environment.dependencyLockSha256,
      result.environment.dependencyLockSha256,
    );
    assert.match(manifest.source.revision, /^[0-9a-f]{40}$/);
    const moved = join(root, "moved");
    await rename(original, moved);
    await input.close();
    const report = await replayBundle(moved, { jar, hostDelay: 1 });
    assert.equal(report.status, "verified");
    assert.equal(report.actual.trace, result.trace);
    const raw = await readBundle(moved);
    assert.ok(raw.includes("9007199254740993"));
    await assert.rejects(recordBundle("/missing", moved, { jar }), /EEXIST/);
    assert.equal(await readBundle(moved), raw);
  } finally {
    await input.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle rejects missing, changed, linked and internally inconsistent evidence before Java admission", async () => {
  const input = await files();
  const root = await mkdtemp(join(tmpdir(), "timeline-bundle-invalid-"));
  try {
    const original = join(root, "original");
    await recordBundle(input.path, original, { jar });
    const mutations = [
      async (dir: string) => rm(join(dir, "manifest.json")),
      async (dir: string) => writeFile(join(dir, "trace.jsonl"), "tampered"),
      async (dir: string) => {
        await rm(join(dir, "scenario.json"));
        await symlink(
          join(original, "scenario.json"),
          join(dir, "scenario.json"),
        );
      },
      async (dir: string) => writeFile(join(dir, "unexpected"), "extra"),
      async (dir: string) => {
        const path = join(dir, "manifest.json");
        const m = JSON.parse(await readFile(path, "utf8"));
        m.files["../escape"] = m.files["run.json"];
        await writeFile(path, JSON.stringify(m));
      },
      async (dir: string) => {
        const path = join(dir, "manifest.json");
        const m = JSON.parse(await readFile(path, "utf8"));
        m.versions.protocol = 2;
        await writeFile(path, JSON.stringify(m));
      },
      async (dir: string) => {
        // Matching file hash alone must not admit a trace disagreeing with run.json.
        const path = join(dir, "manifest.json");
        const m = JSON.parse(await readFile(path, "utf8"));
        const trace = (await readFile(join(dir, "trace.jsonl"), "utf8")) + "\n";
        await writeFile(join(dir, "trace.jsonl"), trace);
        m.files["trace.jsonl"] = {
          bytes: Buffer.byteLength(trace),
          sha256: sha(trace),
        };
        await writeFile(path, JSON.stringify(m));
      },
    ];
    for (const [i, mutate] of mutations.entries()) {
      const dir = join(root, String(i));
      await cp(original, dir, { recursive: true });
      await mutate(dir);
      await assert.rejects(
        replayBundle(dir, { jar: "/missing.jar" }),
        (error) =>
          error instanceof Error &&
          /invalid-bundle|invalid-scenario/.test(error.message),
      );
    }
  } finally {
    await input.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle CLI preserves failed semantics, strict replay exits and immutable evidence", async () => {
  const inputData = fixture();
  inputData.document.assertions[1].expected = [];
  const input = await files(inputData);
  const root = await mkdtemp(join(tmpdir(), "timeline-bundle-cli-"));
  try {
    const dir = join(root, "run");
    const recorded = cli("record", input.path, dir, jar);
    assert.equal(recorded.status, 1, recorded.stderr);
    const original = await readBundle(dir);
    const replayed = cli(
      "replay",
      dir,
      join(root, "report.json"),
      jar,
      "--require-passed",
    );
    assert.equal(replayed.status, 2, replayed.stderr);
    const report = JSON.parse(
      await readFile(join(root, "report.json"), "utf8"),
    );
    assert.equal(report.status, "verified");
    assert.equal(report.recordedOutcome, "assertion-failed");
    const defaultReplay = cli("replay", dir, join(root, "default.json"), jar);
    assert.equal(defaultReplay.status, 0, defaultReplay.stderr);
    assert.equal(cli("replay", dir, join(dir, "report.json"), jar).status, 1);
    await symlink(dir, join(root, "alias"));
    assert.equal(
      cli("replay", dir, join(root, "alias", "report.json"), jar).status,
      1,
    );
    assert.equal(cli("replay", dir, join(root, "report.json"), jar).status, 1);
    assert.equal(await readBundle(dir), original);
  } finally {
    await input.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("validation and startup failures retain diagnostic evidence without a complete manifest", async () => {
  const input = await files();
  const root = await mkdtemp(join(tmpdir(), "timeline-bundle-failure-"));
  try {
    for (const [name, scenario, artifact] of [
      ["validation", "/missing-scenario", jar],
      ["startup", input.path, "/missing.jar"],
    ]) {
      const dir = join(root, name);
      await assert.rejects(recordBundle(scenario, dir, { jar: artifact }));
      const names = await readdir(dir);
      assert.ok(names.includes("failure.json"));
      assert.ok(!names.includes("manifest.json"));
      await assert.rejects(readBundle(dir), /inventory/);
    }
    const limited = fixture();
    limited.document.limits.turns = 2;
    const bounded = await files(limited);
    try {
      const dir = join(root, "limit");
      const result = await recordBundle(bounded.path, dir, { jar });
      assert.equal(result.outcome, "limit-exceeded");
      assert.equal((await replayBundle(dir, { jar })).status, "verified");
    } finally {
      await bounded.close();
    }
  } finally {
    await input.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("process interruption preserves a live prefix without a completeness marker", async () => {
  const input = await files();
  const root = await mkdtemp(join(tmpdir(), "timeline-bundle-interrupted-"));
  const directory = join(root, "run");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'import { recordBundle } from "./src/timeline/artifact-bundle.ts"; await recordBundle(process.argv[1], process.argv[2], {jar: process.argv[3], hostDelay: 250});',
      input.path,
      directory,
      jar,
    ],
    { stdio: "ignore" },
  );
  const closed = once(child, "close");
  try {
    let prefix = "";
    const deadline = Date.now() + 10000;
    while (!prefix && Date.now() < deadline) {
      try {
        prefix = await readFile(join(directory, "trace.jsonl"), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!prefix) await delay(5);
    }
    assert.match(prefix, /timeline-trace\/v1/);
    child.kill("SIGTERM");
    await closed;
    assert.ok(
      (await readFile(join(directory, "trace.jsonl"), "utf8")).startsWith(
        prefix,
      ),
    );
    assert.ok(!(await readdir(directory)).includes("manifest.json"));
    await assert.rejects(readBundle(directory), /inventory/);
  } finally {
    child.kill("SIGKILL");
    await closed;
    await input.close();
    await rm(root, { recursive: true, force: true });
  }
});
