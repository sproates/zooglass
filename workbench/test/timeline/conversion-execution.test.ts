import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseScenario } from "../../src/scenario/scenario.js";
import { runtimeConfiguration } from "../../src/service/runtime-configuration.js";
import {
  conversionHash,
  conversionReport,
} from "../../src/timeline/conversion-document.js";
import { convertLegacyScenario } from "../../src/timeline/conversion.js";
import { runDocument } from "../../src/timeline/run-document.js";
import {
  parseReplay,
  replaySaved,
} from "../../src/timeline/replay-document.js";
import {
  recordBundle,
  readBundle,
  replayBundle,
} from "../../src/timeline/artifact-bundle.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
const options = { epochMillis: 1700000000000, seed: "0".repeat(64) };

test("converted provenance survives direct execution and both replay paths without original files; rehashed contradictory claims fail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "converted-replay-"));
  try {
    const legacy = await readFile("scenarios/live-match.json", "utf8");
    const parsed = parseScenario(JSON.parse(legacy));
    const configuration = JSON.stringify({
      ...runtimeConfiguration(parsed.views, parsed.sources),
      maxStreams: 20,
      identityWindow: 20,
      maxHistoryEntries: 20,
      delivery: { maxQueuedMessages: 128, maxQueuedBytes: 1048576 },
    });
    const legacyPath = join(directory, "input.json");
    const runtime = join(directory, "runtime.json");
    await writeFile(legacyPath, legacy);
    await writeFile(runtime, configuration);
    const output = await convertLegacyScenario(
      legacyPath,
      join(directory, "converted"),
      { ...options, runtime, jar },
    );
    const direct = await runDocument(output.scenario, { jar });
    assert.equal(direct.outcome, "passed");
    assert.equal(direct.conversionProvenance?.legacy, legacy);
    const bundle = join(directory, "bundle");
    assert.equal(
      (await recordBundle(output.scenario, bundle, { jar })).outcome,
      "passed",
    );
    await rm(join(directory, "converted"), { recursive: true });
    await rm(legacyPath);
    await rm(runtime);
    assert.equal(
      (await replaySaved(parseReplay(JSON.stringify(direct)), { jar })).status,
      "verified",
    );
    assert.equal((await replayBundle(bundle, { jar })).status, "verified");

    const savedRaw = await readFile(join(bundle, "run.json"), "utf8");
    const saved = JSON.parse(savedRaw);
    delete saved.conversionProvenance;
    assert.throws(
      () => parseReplay(JSON.stringify(saved)),
      /conversion report is missing/,
    );

    const report = JSON.parse(
      await readFile(join(bundle, "conversion-report.json"), "utf8"),
    );
    report.mapping = [];
    const changedReport = JSON.stringify(report);
    const changedRun = JSON.parse(savedRaw);
    changedRun.conversionProvenance.report = changedReport;
    const bytes = {
      "conversion-report.json": changedReport,
      "run.json": JSON.stringify(changedRun),
    };
    const manifest = JSON.parse(
      await readFile(join(bundle, "manifest.json"), "utf8"),
    );
    for (const [name, contents] of Object.entries(bytes)) {
      await writeFile(join(bundle, name), contents);
      manifest.files[name] = {
        bytes: Buffer.byteLength(contents),
        sha256: conversionHash(contents),
      };
    }
    await writeFile(join(bundle, "manifest.json"), JSON.stringify(manifest));
    await assert.rejects(readBundle(bundle), /regenerated claims/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime preflight rechecks production-normalized equivalence instead of trusting report claims", async () => {
  const directory = await mkdtemp(join(tmpdir(), "converted-config-mismatch-"));
  try {
    const legacy = await readFile("scenarios/live-match.json", "utf8");
    const parsed = parseScenario(JSON.parse(legacy));
    const config = {
      ...runtimeConfiguration(parsed.views, parsed.sources),
      maxStreams: 20,
      identityWindow: 20,
      maxHistoryEntries: 20,
      delivery: { maxQueuedMessages: 128, maxQueuedBytes: 1048576 },
    };
    config.views[0].fields.score.mode = "latestBySequence";
    const wire = JSON.stringify(config);
    const generated = conversionReport(legacy, wire, options, {
      workbenchSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    await writeFile(join(directory, "scenario.json"), generated.canonical);
    await writeFile(join(directory, "configuration.json"), wire);
    await writeFile(
      join(directory, "conversion-report.json"),
      generated.report,
    );
    await writeFile(join(directory, "legacy.json"), legacy);
    await assert.rejects(
      runDocument(join(directory, "scenario.json"), { jar }),
      /reference|equivalent|configuration/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
