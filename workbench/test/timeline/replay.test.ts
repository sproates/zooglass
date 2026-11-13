import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fixture, files } from "./document-fixture.js";
import { runDocument } from "../../src/timeline/run-document.js";
import {
  parseReplay,
  replayDocument,
  ReplayComparison,
} from "../../src/timeline/replay-document.js";
import { canonicalJson } from "../../src/timeline/json.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
async function baseline(f = fixture(), transform = (s: string) => s) {
  const input = await files(f, transform);
  const directory = await mkdtemp(join(tmpdir(), "zooglass-replay-"));
  try {
    const result = await runDocument(input.path, { jar });
    const path = join(directory, "run.json");
    await writeFile(path, JSON.stringify(result));
    return {
      result,
      path,
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } finally {
    await input.close();
  }
}

test("replay uses retained exact inputs after originals disappear, with a fresh delayed JVM", async () => {
  const saved = await baseline(fixture(), (s) =>
    s.replaceAll('"amount":1}', '"amount":9007199254740993}'),
  );
  try {
    const report = await replayDocument(saved.path, {
      jar,
      hostDelay: 1,
      paced: true,
      idlePauseMs: 60,
    });
    assert.equal(report.status, "verified");
    assert.equal(report.recordedOutcome, "passed");
    assert.equal(report.actual.trace, saved.result.trace);
    assert.ok(report.actual.trace.includes("9007199254740993"));
    assert.equal(
      report.matchedRecords,
      saved.result.trace.trimEnd().split("\n").length,
    );
  } finally {
    await saved.close();
  }
});

test("verification reproduces assertion and budget failures without declaring the scenario passed", async () => {
  for (const kind of ["assertion-failed", "limit-exceeded"]) {
    const f = fixture();
    if (kind === "assertion-failed") f.document.assertions[0].expected = [];
    else f.document.limits.turns = 2;
    const saved = await baseline(f);
    try {
      assert.equal(saved.result.outcome, kind);
      const report = await replayDocument(saved.path, { jar });
      assert.equal(report.status, "verified");
      assert.equal(report.recordedOutcome, kind);
      assert.equal(report.actual.outcome, kind);
    } finally {
      await saved.close();
    }
  }
});

test("tampered expected effect stops fresh execution at its first differing record", async () => {
  const saved = await baseline();
  try {
    const lines = saved.result.trace.trimEnd().split("\n");
    const index = lines.findIndex((line) => JSON.parse(line).kind === "state");
    const event = JSON.parse(lines[index]);
    event.data.envelope.data.reading.amount = 987;
    lines[index] = canonicalJson(JSON.stringify(event));
    await writeFile(
      saved.path,
      JSON.stringify({ ...saved.result, trace: lines.join("\n") + "\n" }),
    );
    const report = await replayDocument(saved.path, { jar });
    assert.equal(report.status, "diverged");
    assert.equal(report.divergence?.record, index);
    assert.equal(report.divergence?.expected, lines[index] + "\n");
    assert.equal(report.matchedRecords, index);
    assert.equal(report.actual.trace.trimEnd().split("\n").length, index + 1);
    assert.ok(!report.actual.trace.includes('"actionId":"send-2"'));
  } finally {
    await saved.close();
  }
});

test("corrupt/incomplete runs and mismatched inputs or artifact identities never qualify for replay", async () => {
  const saved = await baseline();
  try {
    for (const change of [
      { configuration: saved.result.configuration + " " },
      { outcome: "assertion-failed" },
      { outcome: "infrastructure-failed" },
      {
        trace:
          saved.result.trace.trimEnd().split("\n").slice(0, -1).join("\n") +
          "\n",
      },
      {
        scenario: saved.result.scenario.replace(
          '"untilMs":110',
          '"untilMs":111',
        ),
      },
    ])
      assert.throws(() =>
        parseReplay(JSON.stringify({ ...saved.result, ...change })),
      );
    assert.throws(
      () =>
        parseReplay('{"format":"timeline-run/v1","format":"timeline-run/v1"}'),
      /duplicate/,
    );
    for (const field of ["artifactSha256", "workbenchSha256"] as const) {
      const execution = { ...saved.result.execution, [field]: "0".repeat(64) };
      const lines = saved.result.trace.trimEnd().split("\n");
      lines[0] = canonicalJson(
        JSON.stringify({ ...JSON.parse(lines[0]), execution }),
      );
      await writeFile(
        saved.path,
        JSON.stringify({
          ...saved.result,
          execution,
          trace: lines.join("\n") + "\n",
        }),
      );
      await assert.rejects(
        replayDocument(saved.path, { jar }),
        /identity mismatch|artifact mismatch/,
      );
    }
  } finally {
    await saved.close();
  }
});

test("environment mismatch is rejected before document execution", async () => {
  const saved = await baseline();
  try {
    await writeFile(
      saved.path,
      JSON.stringify({
        ...saved.result,
        environment: { ...saved.result.environment, node: "different" },
      }),
    );
    await assert.rejects(
      replayDocument(saved.path, { jar }),
      /environment mismatch/,
    );
  } finally {
    await saved.close();
  }
});

test("record comparison identifies missing and additional records without substituting output", () => {
  const missing = new ReplayComparison(["first\n", "second\n"]);
  missing.observe("first\n");
  missing.finish();
  assert.deepEqual(missing.divergence, {
    record: 1,
    expected: "second\n",
    actual: null,
  });
  const extra = new ReplayComparison(["first\n"]);
  extra.observe("first\n");
  assert.throws(() => extra.observe("extra\n"), /record 1/);
  assert.deepEqual(extra.divergence, {
    record: 1,
    expected: null,
    actual: "extra\n",
  });
});

test("replay CLI writes a verified report and preserves the saved run", async () => {
  const saved = await baseline();
  try {
    const { execFileSync } = await import("node:child_process");
    const output = saved.path + ".replay.json";
    const original = await readFile(saved.path, "utf8");
    execFileSync(process.execPath, [
      "--import",
      "tsx",
      "src/timeline/replay-cli.ts",
      saved.path,
      output,
      jar,
    ]);
    assert.equal(JSON.parse(await readFile(output, "utf8")).status, "verified");
    assert.equal(await readFile(saved.path, "utf8"), original);
  } finally {
    await saved.close();
  }
});

test("replay CLI refuses symlink and hardlink outputs that alias saved evidence", async () => {
  const saved = await baseline();
  try {
    const { execFileSync } = await import("node:child_process");
    const { symlink, link } = await import("node:fs/promises");
    const original = await readFile(saved.path, "utf8");
    for (const [name, create] of [
      ["symlink", symlink],
      ["hardlink", link],
    ] as const) {
      const output = saved.path + name;
      await create(saved.path, output);
      assert.throws(() =>
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "src/timeline/replay-cli.ts",
            saved.path,
            output,
            jar,
          ],
          { stdio: "pipe" },
        ),
      );
      assert.equal(await readFile(saved.path, "utf8"), original);
    }
  } finally {
    await saved.close();
  }
});

test("require-passed distinguishes reproduced failures while preserving default verification exit", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const outcome of ["passed", "assertion-failed", "limit-exceeded"]) {
    const f = fixture();
    if (outcome === "assertion-failed") f.document.assertions[0].expected = [];
    if (outcome === "limit-exceeded") f.document.limits.turns = 2;
    const saved = await baseline(f);
    try {
      for (const requirePassed of [false, true]) {
        const output = saved.path + `.${requirePassed}.json`;
        const child = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "src/timeline/replay-cli.ts",
            saved.path,
            output,
            jar,
            ...(requirePassed ? ["--require-passed"] : []),
          ],
          { encoding: "utf8" },
        );
        assert.equal(
          child.status,
          requirePassed && outcome !== "passed" ? 2 : 0,
          child.stderr,
        );
        const report = JSON.parse(await readFile(output, "utf8"));
        assert.equal(report.status, "verified");
        assert.equal(report.recordedOutcome, outcome);
      }
    } finally {
      await saved.close();
    }
  }
});

test("require-passed still rejects divergence and invalid/incomplete evidence", async () => {
  const { spawnSync } = await import("node:child_process");
  const saved = await baseline();
  try {
    const lines = saved.result.trace.trimEnd().split("\n");
    const index = lines.findIndex((line) => JSON.parse(line).kind === "state");
    const changed = JSON.parse(lines[index]);
    changed.data.envelope.data.reading.amount = 987;
    lines[index] = canonicalJson(JSON.stringify(changed));
    for (const kind of ["diverged", "incomplete", "invalid"]) {
      const trace =
        kind === "diverged"
          ? lines.join("\n") + "\n"
          : saved.result.trace.trimEnd().split("\n").slice(0, -1).join("\n") +
            "\n";
      await writeFile(
        saved.path,
        kind === "invalid" ? "{" : JSON.stringify({ ...saved.result, trace }),
      );
      const output = saved.path + `.${kind}.json`;
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/timeline/replay-cli.ts",
          saved.path,
          output,
          jar,
          "--require-passed",
        ],
        { encoding: "utf8" },
      );
      assert.equal(child.status, 1);
      if (kind === "diverged")
        assert.equal(
          JSON.parse(await readFile(output, "utf8")).status,
          "diverged",
        );
      else await assert.rejects(readFile(output), /ENOENT/);
    }
  } finally {
    await saved.close();
  }
});
