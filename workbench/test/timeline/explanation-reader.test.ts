import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  explainBundle,
  writeExplanation,
} from "../../src/explanation/reader.js";
import { canonicalJson } from "../../src/timeline/json.js";
import { fixture } from "./document-fixture.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function retainedLegacy(root: string, outcome = "passed") {
  const directory = join(root, outcome);
  await mkdir(directory);
  const input = fixture();
  input.document.actions = [];
  input.document.assertions = [];
  const configuration = JSON.stringify(input.configuration);
  input.document.runtime.sha256 = sha(configuration);
  const scenario = canonicalJson(JSON.stringify(input.document));
  const execution = {
    profile: "memory-arrival-v1",
    artifactSha256: "a".repeat(64),
    configurationSha256: sha(configuration),
    workbenchSha256: "b".repeat(64),
  };
  const trace = [
    {
      format: "timeline-trace/v1",
      scenarioSha256: sha(scenario),
      untilMs: 110,
      execution,
    },
    {
      kind: "result",
      outcome,
      eventCount: 0,
      pendingFutureTasks: 0,
      pendingMessages: 0,
      heldFrames: 0,
    },
  ]
    .map((value) => canonicalJson(JSON.stringify(value)) + "\n")
    .join("");
  const environment = {};
  const files = {
    "scenario.json": scenario,
    "configuration.json": configuration,
    "trace.jsonl": trace,
    "run.json": JSON.stringify({
      format: "timeline-run/v1",
      environment,
      outcome,
      scenario,
      configuration,
      execution,
      trace,
    }),
  };
  const manifest = JSON.stringify({
    format: "timeline-bundle/v1",
    versions: {
      scenario: "timeline-simulation/v1",
      trace: "timeline-trace/v1",
      scheduler: "time-round-phase-ordinal/v1",
      randomness: "sha256-length-prefixed/v1",
      protocol: 1,
    },
    source: { revision: null, trackedChanges: null },
    initialState: { storage: "memory", state: "empty" },
    outcome,
    execution,
    environment,
    files: Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [
        name,
        { bytes: Buffer.byteLength(bytes), sha256: sha(bytes) },
      ]),
    ),
  });
  for (const [name, bytes] of Object.entries({
    ...files,
    "manifest.json": manifest,
  }))
    await writeFile(join(directory, name), bytes);
  return { directory, manifest, trace };
}
function cli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/explanation/cli.ts", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: "", JAVA_HOME: "/no-java-installed" },
    },
  );
}

test("offline CLI validates retained bundle without Java or matching local artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "timeline-explain-"));
  try {
    const { directory, manifest, trace } = await retainedLegacy(root);
    const output = join(root, "report.json");
    const result = cli(directory, output, "--format", "json");
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(report.input, {
      manifestSha256: sha(manifest),
      traceSha256: sha(trace),
    });
    assert.equal(report.replayStatus, "not-run");
    assert.equal(report.coverage.detailedRuntimeDecisions, "not-recorded");
    assert.deepEqual(report.entries, []);
    assert.equal(
      await readFile(join(directory, "manifest.json"), "utf8"),
      manifest,
    );
    assert.equal(await readFile(join(directory, "trace.jsonl"), "utf8"), trace);
    const second = join(root, "second.json");
    assert.equal(await writeExplanation(directory, second, "json"), 0);
    assert.equal(
      await readFile(second, "utf8"),
      await readFile(output, "utf8"),
    );
    const limited = await retainedLegacy(root, "limit-exceeded");
    assert.equal(
      cli(limited.directory, join(root, "limited.txt"), "--format", "text")
        .status,
      2,
    );
    assert.match(
      await readFile(join(root, "limited.txt"), "utf8"),
      /limit-exceeded; replay: not-run/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reader refuses changed evidence, unknown IDs, contained outputs and existing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "timeline-explain-"));
  try {
    const { directory, trace } = await retainedLegacy(root);
    await assert.rejects(
      writeExplanation(directory, join(directory, "report.json"), "json"),
      /outside/,
    );
    const alias = join(root, "alias");
    await symlink(directory, alias);
    await assert.rejects(
      writeExplanation(directory, join(alias, "report.json"), "json"),
      /outside/,
    );
    const output = join(root, "report.json");
    await writeFile(output, "keep me");
    await assert.rejects(writeExplanation(directory, output, "json"), /EEXIST/);
    assert.equal(await readFile(output, "utf8"), "keep me");
    await assert.rejects(
      explainBundle(directory, "unknown"),
      /Unknown event ID/,
    );
    const bad = cli(directory, join(root, "bad.json"), "--format", "html");
    assert.equal(bad.status, 1);
    assert.ok(!(await readdir(root)).includes("bad.json"));
    await writeFile(join(directory, "trace.jsonl"), trace + " ");
    await assert.rejects(explainBundle(directory), /hash\/size mismatch/);
    assert.equal(
      cli(directory, join(root, "invalid.json"), "--format", "json").status,
      1,
    );
    assert.ok(!(await readdir(root)).includes("invalid.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
