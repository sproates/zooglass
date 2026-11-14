import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { inspectAdmission } from "../../src/timeline/admission.js";
import { runDocument } from "../../src/timeline/run-document.js";
import { RunStore } from "../../src/timeline/run-store.js";
import { files, fixture } from "./document-fixture.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);

test("SQLite cleanup failure retains the same uncompleted trace returned and streamed by the runner", async (context) => {
  const input = fixture();
  input.document.format = "timeline-simulation/v2";
  input.configuration.storage = input.document.runtime.storage = "sqlite";
  input.document.actions = [];
  input.document.assertions = [];
  input.document.untilMs = 0;
  const saved = await files(input);
  const directory = await mkdtemp(join(tmpdir(), "timeline-cleanup-failure-"));
  context.mock.method(RunStore.prototype, "remove", async () => {
    throw new Error("injected database directory removal failure");
  });

  try {
    const lines: string[] = [];
    const run = await runDocument(saved.path, {
      jar,
      diagnosticDirectory: directory,
      observeRecord: (line) => lines.push(line),
    });

    assert.equal(run.outcome, "infrastructure-failed");
    assert.match(
      run.message ?? "",
      /injected database directory removal failure/,
    );
    assert.equal(lines.join(""), run.trace);
    assert.ok(
      lines.some((line) => JSON.parse(line).kind === "runtime-initialized"),
    );
    assert.ok(lines.every((line) => JSON.parse(line).kind !== "result"));
    const retained = run.diagnostics.retainedStore;
    assert.ok(retained?.database);
    assert.ok((await stat(retained.database)).isFile());
    assert.equal((await readdir(directory)).length, 1);
    assert.ok(!run.trace.includes(directory));
  } finally {
    await saved.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an entity blank to the native host is rejected before allocating SQLite storage", async () => {
  const input = fixture();
  input.document.format = "timeline-simulation/v2";
  input.configuration.storage = input.document.runtime.storage = "sqlite";
  input.document.assertions = [];
  const saved = await files(input, (document) =>
    JSON.stringify({
      ...JSON.parse(document),
      observationTargets: [{ viewId: "stock-view", entityId: "\u001c\u001f" }],
    }),
  );
  const directory = await mkdtemp(join(tmpdir(), "timeline-target-admission-"));

  try {
    const inspection = await inspectAdmission(saved.path, jar);
    assert.equal(inspection.execution, "unsupported");
    assert.match(
      inspection.reason,
      /observation target entity is blank to the runtime/,
    );
    await assert.rejects(
      runDocument(saved.path, { jar, diagnosticDirectory: directory }),
      /observation target entity is blank to the runtime/,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await saved.close();
    await rm(directory, { recursive: true, force: true });
  }
});
