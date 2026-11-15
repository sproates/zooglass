import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseScenario } from "../../src/scenario/scenario.js";
import { runtimeConfiguration } from "../../src/service/runtime-configuration.js";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import {
  conversionReport,
  conversionHash,
} from "../../src/timeline/conversion-document.js";
import {
  conversionBundleFiles,
  conversionReferenceConfiguration,
  loadConversionProvenance,
  validateConversionProvenance,
} from "../../src/timeline/conversion-provenance.js";

async function fixture() {
  const legacy = await readFile("scenarios/live-match.json", "utf8");
  const scenario = parseScenario(JSON.parse(legacy));
  const configuration = JSON.stringify({
    ...runtimeConfiguration(scenario.views, scenario.sources),
    maxStreams: 20,
    identityWindow: 20,
    maxHistoryEntries: 20,
    delivery: { maxQueuedMessages: 128, maxQueuedBytes: 1048576 },
  });
  const generated = conversionReport(
    legacy,
    configuration,
    { epochMillis: 1700000000000, seed: "0".repeat(64) },
    { workbenchSha256: "a".repeat(64), artifactSha256: "b".repeat(64) },
  );
  return {
    legacy,
    configuration,
    generated,
    scenario: parseTimelineDocument(generated.canonical),
    provenance: { legacy, report: generated.report },
  };
}

test("offline provenance regenerates claims and records identity without requiring the current converter", async () => {
  const item = await fixture();
  assert.deepEqual(
    validateConversionProvenance(
      item.scenario,
      item.configuration,
      item.provenance,
    ),
    item.provenance,
  );
  assert.equal(
    conversionReferenceConfiguration(item.provenance),
    JSON.parse(item.generated.report).referenceConfiguration,
  );
  assert.deepEqual(conversionBundleFiles(item.provenance), {
    "conversion-report.json": item.generated.report,
    "legacy.json": item.legacy,
  });
});

test("missing, undeclared and malformed provenance fail closed", async () => {
  const item = await fixture();
  assert.throws(
    () => validateConversionProvenance(item.scenario, item.configuration),
    /missing/,
  );
  const manual = JSON.parse(item.generated.canonical);
  delete manual.conversionReport;
  const scenario = parseTimelineDocument(JSON.stringify(manual));
  assert.equal(
    validateConversionProvenance(scenario, item.configuration),
    undefined,
  );
  assert.throws(
    () =>
      validateConversionProvenance(
        scenario,
        item.configuration,
        item.provenance,
      ),
    /undeclared/,
  );
  const malformed = JSON.parse(item.generated.report);
  malformed.converter.workbenchSha256 = "short";
  assert.throws(
    () =>
      validateConversionProvenance(item.scenario, item.configuration, {
        ...item.provenance,
        report: JSON.stringify(malformed),
      }),
    /identity/,
  );
});

test("rewritten outer hashes cannot hide changed mappings, copied expectations, bounds or adaptations", async () => {
  const item = await fixture();
  const mutations = [
    (report: Record<string, unknown>) => {
      report.mapping = [];
    },
    (report: Record<string, unknown>) => {
      report.preservedExpectations = [];
    },
    (report: Record<string, unknown>) => {
      report.adaptations = [];
    },
    (report: Record<string, unknown>) => {
      report.finiteInput = {};
    },
    (report: Record<string, unknown>) => {
      report.resourceBounds = {};
    },
    (report: Record<string, unknown>) => {
      report.referenceConfiguration = "{}";
    },
    (report: Record<string, unknown>) => {
      report.scenarioCanonicalSha256 = "0".repeat(64);
    },
    (report: Record<string, unknown>) => {
      report.rejectedConstructs = [{ path: "$", reason: "silently ignored" }];
    },
  ];
  for (const mutate of mutations) {
    const report = JSON.parse(item.generated.report);
    mutate(report);
    const provenance = { ...item.provenance, report: JSON.stringify(report) };
    // A bundle can hash any bytes; semantic validation must still reject inconsistent claims.
    assert.match(conversionHash(provenance.report), /^[a-f0-9]{64}$/);
    assert.throws(
      () =>
        validateConversionProvenance(
          item.scenario,
          item.configuration,
          provenance,
        ),
      /regenerated claims/,
    );
  }
});

test("coordinated scenario/report edits cannot replace the original authored expected value", async () => {
  const item = await fixture();
  const changed = JSON.parse(item.generated.canonical);
  const check = changed.assertions.find(
    (value: { kind: string }) => value.kind === "runtime-data",
  );
  check.expected.score.home = 999;
  const scenario = parseTimelineDocument(JSON.stringify(changed));
  const report = JSON.parse(item.generated.report);
  report.scenarioCanonicalSha256 = conversionHash(scenario.canonical);
  report.preservedExpectations[0].expected.score.home = 999;
  assert.throws(
    () =>
      validateConversionProvenance(scenario, item.configuration, {
        ...item.provenance,
        report: JSON.stringify(report),
      }),
    /original legacy transcription/,
  );
  assert.throws(
    () =>
      validateConversionProvenance(
        item.scenario,
        `${item.configuration}\n`,
        item.provenance,
      ),
    /transcription/,
  );
  assert.throws(
    () =>
      validateConversionProvenance(item.scenario, item.configuration, {
        ...item.provenance,
        legacy: `${item.legacy}\n`,
      }),
    /transcription/,
  );
});

test("safe loading requires declared files and rejects symlinks or escaping paths", async () => {
  const item = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "timeline-provenance-"));
  try {
    const scenarioPath = join(directory, "scenario.json");
    await writeFile(scenarioPath, item.generated.canonical);
    await assert.rejects(
      loadConversionProvenance(scenarioPath, item.scenario, item.configuration),
      { code: "ENOENT" },
    );
    await writeFile(
      join(directory, "conversion-report.json"),
      item.generated.report,
    );
    await writeFile(join(directory, "legacy.json"), item.legacy);
    assert.deepEqual(
      await loadConversionProvenance(
        scenarioPath,
        item.scenario,
        item.configuration,
      ),
      item.provenance,
    );
    await rm(join(directory, "legacy.json"));
    await writeFile(join(directory, "actual-legacy.json"), item.legacy);
    await symlink("actual-legacy.json", join(directory, "legacy.json"));
    await assert.rejects(
      loadConversionProvenance(scenarioPath, item.scenario, item.configuration),
      /regular provenance file/,
    );
    const escaped = JSON.parse(item.generated.canonical);
    escaped.conversionReport = "../outside.json";
    assert.throws(
      () => parseTimelineDocument(JSON.stringify(escaped)),
      /relative contained/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
