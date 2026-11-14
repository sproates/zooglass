import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fixture, files } from "./document-fixture.js";
import { recordBundle } from "../../src/timeline/artifact-bundle.js";
import { parseReplay } from "../../src/timeline/replay-document.js";
import { compareRuns } from "../../src/timeline/compare.js";
import { canonicalJson } from "../../src/timeline/json.js";
import {
  replayArguments,
  replayExitCode,
} from "../../src/timeline/replay-policy.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
const cli = (...args: string[]) =>
  spawnSync(
    process.execPath,
    ["--import", "tsx", "src/timeline/compare-cli.ts", ...args],
    { encoding: "utf8" },
  );

test("compare validates saved evidence, reports first difference and rejects incompatible identities without Java", async () => {
  const input = await files();
  const root = await mkdtemp(join(tmpdir(), "timeline-compare-"));
  try {
    const bundle = join(root, "bundle");
    const run = await recordBundle(input.path, bundle, { jar });
    const raw = JSON.stringify(run);
    const parsed = parseReplay(raw);
    assert.throws(() =>
      compareRuns(
        parsed,
        parseReplay(JSON.stringify({ ...run, environment: {} })),
      ),
    );
    assert.equal(
      compareRuns(
        parsed,
        parseReplay(JSON.stringify({ ...run, diagnostics: {} })),
      ).status,
      "equal",
    );
    const report = join(root, "equal.json");
    assert.equal(cli(bundle, join(bundle, "run.json"), report).status, 0);
    assert.equal(
      JSON.parse(await readFile(report, "utf8")).executionVerified,
      false,
    );
    const shortened = { ...parsed, lines: parsed.lines.slice(0, -1) };
    assert.equal(compareRuns(parsed, shortened).difference?.right, null);
    assert.equal(compareRuns(shortened, parsed).difference?.left, null);
    const changedExecution = {
      ...run.execution,
      artifactSha256: "0".repeat(64),
    };
    const oldLines = run.trace.trimEnd().split("\n");
    oldLines[0] = canonicalJson(
      JSON.stringify({
        ...JSON.parse(oldLines[0]),
        execution: changedExecution,
      }),
    );
    const oldArtifact = parseReplay(
      JSON.stringify({
        ...run,
        execution: changedExecution,
        trace: oldLines.join("\n") + "\n",
      }),
    );
    assert.deepEqual(compareRuns(parsed, oldArtifact).mismatches, [
      "execution",
    ]);
    assert.equal(compareRuns(oldArtifact, oldArtifact).status, "equal");
    const lines = run.trace.trimEnd().split("\n");
    const index = lines.findIndex((line) => JSON.parse(line).kind === "state");
    const event = JSON.parse(lines[index]);
    event.data.envelope.data.reading.amount = 987;
    lines[index] = canonicalJson(JSON.stringify(event));
    const changed = { ...run, trace: lines.join("\n") + "\n" };
    const path = join(root, "changed.json");
    await writeFile(path, JSON.stringify(changed));
    const different = join(root, "different.json");
    assert.equal(cli(bundle, path, different).status, 2);
    const result = JSON.parse(await readFile(different, "utf8"));
    assert.equal(result.difference.record, index);
    assert.equal(result.matchedRecords, index);
    for (const field of ["node", "timezone"]) {
      const other = parseReplay(
        JSON.stringify({
          ...run,
          environment: { ...run.environment, [field]: "different" },
        }),
      );
      assert.deepEqual(compareRuns(parsed, other).mismatches, ["environment"]);
    }
    for (const malformed of [
      "{",
      JSON.stringify({ ...run, trace: run.trace.slice(0, -20) }),
    ]) {
      await writeFile(path, malformed);
      assert.equal(cli(bundle, path, join(root, "invalid.json")).status, 1);
      await assert.rejects(readFile(join(root, "invalid.json")), /ENOENT/);
    }
    await symlink(bundle, join(root, "alias"));
    assert.equal(
      cli(bundle, bundle, join(root, "alias", "new.json")).status,
      1,
    );
    for (const [name, create] of [
      ["symbolic", symlink],
      ["hard", link],
    ] as const) {
      const output = join(root, name);
      await create(join(bundle, "run.json"), output);
      assert.equal(cli(bundle, bundle, output).status, 1);
    }
    assert.equal(await readFile(join(bundle, "run.json"), "utf8"), raw + "\n");
  } finally {
    await input.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("equal failed runs remain labelled failed, and comparison needs no current artifact", async () => {
  const f = fixture();
  f.document.assertions[0].expected = [];
  const input = await files(f);
  const root = await mkdtemp(join(tmpdir(), "timeline-compare-failed-"));
  try {
    const run = await recordBundle(input.path, join(root, "bundle"), { jar });
    const result = compareRuns(
      parseReplay(JSON.stringify(run)),
      parseReplay(JSON.stringify(run)),
    );
    assert.equal(result.status, "equal");
    assert.equal(result.leftOutcome, "assertion-failed");
    assert.equal(result.executionVerified, false);
  } finally {
    await input.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("replay policy rejects conflicting, duplicate and unknown flags; failure cannot be verified away", () => {
  for (const args of [
    ["--verification-only", "--require-passed"],
    ["--verification-only", "--verification-only"],
    ["--bad"],
  ])
    assert.throws(() => replayArguments(args));
  for (const status of ["diverged", "infrastructure-failed"])
    for (const mode of [false, true])
      assert.equal(
        replayExitCode({ status, recordedOutcome: "passed" }, mode),
        1,
      );
});

test("execute rejects extra options and preserves existing scenario/evidence files", async () => {
  const input = await files();
  try {
    const original = await readFile(input.path, "utf8");
    const execute = (...args: string[]) =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", "src/timeline/document-cli.ts", ...args],
        { encoding: "utf8" },
      );
    assert.equal(execute(input.path, input.path, jar).status, 1);
    assert.equal(await readFile(input.path, "utf8"), original);
    assert.equal(execute(input.path, input.path, jar, "extra").status, 1);
    assert.equal(execute(input.path, input.path, "--bad").status, 1);
  } finally {
    await input.close();
  }
});

test("v2 SQLite bundles compare offline and distinguish scenario/configuration identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "timeline-compare-sqlite-"));
  try {
    const bundle = join(root, "bundle");
    const run = await recordBundle(
      resolve("scenarios/simulation/sqlite-restart.json"),
      bundle,
      { jar },
    );
    assert.equal(run.outcome, "passed");
    const base = parseReplay(JSON.stringify(run));
    assert.equal(
      cli(bundle, join(bundle, "run.json"), join(root, "equal.json")).status,
      0,
    );
    const sha = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    for (const change of ["scenario", "configuration"]) {
      const document = JSON.parse(run.scenario);
      const configuration =
        change === "configuration"
          ? run.configuration + " "
          : run.configuration;
      if (change === "configuration")
        document.runtime.sha256 = sha(configuration);
      else document.seed = sha("different-comparison-seed");
      const scenario = canonicalJson(JSON.stringify(document));
      const execution = {
        ...run.execution,
        configurationSha256: sha(configuration),
      };
      const lines = run.trace.trimEnd().split("\n");
      lines[0] = canonicalJson(
        JSON.stringify({
          ...JSON.parse(lines[0]),
          scenarioSha256: sha(scenario),
          execution,
        }),
      );
      const other = parseReplay(
        JSON.stringify({
          ...run,
          scenario,
          configuration,
          execution,
          trace: lines.join("\n") + "\n",
        }),
      );
      assert.deepEqual(
        compareRuns(base, other).mismatches,
        change === "scenario"
          ? ["scenario"]
          : ["scenario", "configuration", "execution"],
      );
    }
    const environment = {
      ...run.environment,
      java: { ...run.environment.java, sqliteVersion: "different" },
    };
    assert.deepEqual(
      compareRuns(base, parseReplay(JSON.stringify({ ...run, environment })))
        .mismatches,
      ["environment"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
