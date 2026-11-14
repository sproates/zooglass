import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { inspectAdmission } from "../../src/timeline/admission.js";
import {
  readBundle,
  recordBundle,
  replayBundle,
} from "../../src/timeline/artifact-bundle.js";
import { fleetProfile } from "../../src/timeline/evidence-versions.js";
import { canonicalJson } from "../../src/timeline/json.js";
import { parseReplay } from "../../src/timeline/replay-document.js";
import { parseTrace } from "../../src/timeline/trace-contract.js";
import { runDocument } from "../../src/timeline/run-document.js";
import { action, fixture, receipt, source } from "./document-fixture.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);

// A single publication fans out through two real sequence strategies. The full fleet
// and late/history business oracles belong to the subsequent scenario qualification.
async function inputFiles() {
  const directory = await mkdtemp(join(tmpdir(), "timeline-fleet-boundary-"));
  const base = fixture();
  const configuration = {
    ...base.configuration,
    views: [
      {
        id: "latest",
        fields: {
          reading: {
            sourceId: "warehouse-feed",
            type: "stock",
            mode: "latestBySequence",
          },
        },
      },
      {
        id: "journey",
        fields: {
          reading: {
            sourceId: "warehouse-feed",
            type: "stock",
            mode: "historyBySequence",
          },
        },
      },
    ],
  };
  const expected = receipt(1, 1);
  expected.changedViews = ["latest", "journey"];
  expected.targets = ["latest", "journey"].map((viewId) => ({
    ...receipt(1, 1).targets[0],
    viewId,
  }));
  const wire = JSON.stringify(configuration);
  const document = {
    ...base.document,
    format: "timeline-simulation/v2",
    runtime: {
      ...base.document.runtime,
      profile: fleetProfile,
      sha256: createHash("sha256").update(wire).digest("hex"),
    },
    actions: [
      action("connect", 0, "connect", source),
      action("send", 10, "source-send", source, { publication: "report-1" }),
    ],
    assertions: [
      {
        id: "fanout-receipt",
        atMs: 10,
        kind: "source-receipts",
        actor: source,
        expected: [expected],
      },
    ],
  };
  const path = join(directory, "scenario.json");
  await writeFile(join(directory, "runtime.json"), wire);
  await writeFile(path, JSON.stringify(document));
  return {
    directory,
    path,
    document,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("fleet admission, initialization and bundle replay retain the chosen configuration identity", async () => {
  const input = await inputFiles();
  try {
    const admission = await inspectAdmission(input.path, jar);
    assert.equal(admission.execution, "eligible", admission.reason);
    assert.equal(admission.documentProfile, fleetProfile);
    const directory = join(input.directory, "bundle");
    const run = await recordBundle(input.path, directory, { jar });
    assert.equal(run.outcome, "passed", run.message);
    assert.equal(run.execution.profile, fleetProfile);
    assert.equal(run.environment.executor, `${fleetProfile}/1`);
    assert.equal(run.format, "timeline-run/v2");
    const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.format, "timeline-bundle/v2");
    assert.equal(
      parseReplay(JSON.stringify(run)).execution.profile,
      fleetProfile,
    );
    assert.equal((await replayBundle(directory, { jar })).status, "verified");
    const changedManifest = structuredClone(manifest);
    changedManifest.execution.profile = "receipt-age-restart-v1";
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify(changedManifest),
    );
    await assert.rejects(
      readBundle(directory),
      /execution\/environment mismatch/,
    );
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    assert.throws(
      () =>
        parseTrace(
          run.trace.replace('"timeline-trace/v2"', '"timeline-trace/v1"'),
        ),
      /execution.profile: supported values: memory-arrival-v1/,
    );

    // Relabel both agreeing evidence copies: the retained scenario must still reject it.
    const relabelled = structuredClone(run);
    relabelled.execution.profile = "receipt-age-restart-v1";
    const lines = relabelled.trace
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    lines[0].execution.profile = "receipt-age-restart-v1";
    relabelled.trace =
      lines.map((line) => canonicalJson(JSON.stringify(line))).join("\n") +
      "\n";
    assert.throws(
      () => parseReplay(JSON.stringify(relabelled)),
      /execution identity mismatch/,
    );
    assert.throws(
      () =>
        parseReplay(
          JSON.stringify({
            ...run,
            environment: {
              ...run.environment,
              executor: "receipt-age-restart-v1/1",
            },
          }),
        ),
      /executor profile mismatch/,
    );

    const { profile, ...runtime } = input.document.runtime;
    assert.equal(profile, fleetProfile);
    await writeFile(input.path, JSON.stringify({ ...input.document, runtime }));
    assert.equal(
      (await inspectAdmission(input.path, jar)).execution,
      "unsupported",
    );
    await assert.rejects(
      runDocument(input.path, { jar }),
      /configuration is outside memory-arrival-v1/,
    );

    // Explicit selection cannot relabel a configuration belonging to the old profile.
    const oldWire = JSON.stringify(fixture().configuration);
    await writeFile(join(input.directory, "runtime.json"), oldWire);
    await writeFile(
      input.path,
      JSON.stringify({
        ...input.document,
        runtime: {
          ...input.document.runtime,
          sha256: createHash("sha256").update(oldWire).digest("hex"),
        },
      }),
    );
    assert.equal(
      (await inspectAdmission(input.path, jar)).execution,
      "unsupported",
    );
    await assert.rejects(
      runDocument(input.path, { jar }),
      /configuration is outside memory-sequence-fleet-v1/,
    );
  } finally {
    await input.close();
  }
});
