import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseScenario } from "../../src/scenario/scenario.js";
import { runtimeConfiguration } from "../../src/service/runtime-configuration.js";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import { conversionDocument } from "../../src/timeline/conversion-document.js";
import {
  checkConversionResources,
  conversionInput,
} from "../../src/timeline/conversion-eligibility.js";
import { convertLegacyScenario } from "../../src/timeline/conversion.js";
import { loadConversionProvenance } from "../../src/timeline/conversion-provenance.js";

export const options = { epochMillis: 1_700_000_000_000, seed: "0".repeat(64) };
export function boundedConfiguration(legacy: string) {
  const input = parseScenario(JSON.parse(legacy));
  return JSON.stringify({
    ...runtimeConfiguration(input.views, input.sources),
    maxStreams: 20,
    identityWindow: 20,
    maxHistoryEntries: 20,
    delivery: { maxQueuedMessages: 128, maxQueuedBytes: 1048576 },
  });
}
const accepted = new Set([
  "live-match.json",
  "late-update.json",
  "bursty-updates.json",
  "sequence-gap.json",
  "shared-sequence-across-entities.json",
]);

test("the frozen nineteen-fixture corpus has exactly five conversion acceptances", async () => {
  const names = [
    ...(await readdir("scenarios")).filter((name) => name.endsWith(".json")),
    "browser/vehicle-connection-loss.json",
  ];
  assert.equal(names.length, 19);
  for (const name of names) {
    const raw = await readFile(join("scenarios", name), "utf8");
    if (accepted.has(name))
      assert.doesNotThrow(() => conversionInput(raw), name);
    else
      assert.throws(() => conversionInput(raw), /unsupported-conversion/, name);
  }
});

test("five conversions preserve literal data expectations, publication bytes and timestamps without executing outcomes", async () => {
  let publications = 0;
  let checks = 0;
  for (const name of accepted) {
    const legacy = await readFile(join("scenarios", name), "utf8");
    const configuration = boundedConfiguration(legacy);
    const result = conversionDocument(legacy, configuration, options);
    const document = JSON.parse(result.canonical);
    assert.equal(document.format, "timeline-simulation/v3");
    assert.equal(document.runtime.profile, "memory-static-views-v1");
    assert.equal(document.conversionReport, "conversion-report.json");
    assert.deepEqual(document.end, {
      heldFrames: 0,
      pendingFutureTasks: "forbid",
      pendingMessages: 0,
    });
    assert.ok(
      document.links.every(
        (link: { latencyMs: number }) => link.latencyMs === 0,
      ),
    );
    assert.equal(
      result.canonical,
      conversionDocument(legacy, configuration, options).canonical,
    );
    const input = JSON.parse(legacy);
    for (const [i, entry] of input.timeline.entries()) {
      if (entry.kind === "source-event") {
        publications++;
        const publication = document.publications.find(
          (item: { id: string }) => item.id === `publication-${i}`,
        );
        assert.deepEqual(publication.body, {
          sourceId: entry.sourceId,
          epoch: entry.epoch,
          sourceEntityId: entry.entityId,
          publicationSequence: entry.publicationSequence,
          type: entry.type,
          payload: entry.payload,
        });
        const send = document.actions.find(
          (item: { id: string }) => item.id === `send-${i}`,
        );
        assert.equal(send.atMs, entry.simulationTime);
        assert.ok(
          document.assertions.some(
            (item: { kind: string; send: string; atMs: number }) =>
              item.kind === "source-accepted" &&
              item.send === send.id &&
              item.atMs === send.atMs,
          ),
        );
      } else {
        checks++;
        const assertion = document.assertions.find(
          (item: { id: string }) => item.id === `check-${i}`,
        );
        assert.deepEqual(assertion.expected, entry.expected);
        assert.equal(assertion.atMs, entry.simulationTime);
      }
    }
    if (name === "live-match.json") {
      assert.ok(
        document.actions.some(
          (item: { id: string }) => item.id === "connect-client-0",
        ),
      );
      assert.ok(
        document.actions.every(
          (item: { kind: string }) => item.kind !== "client-subscribe",
        ),
      );
    }
    assert.doesNotThrow(() => parseTimelineDocument(result.canonical));
  }
  assert.equal(publications, 20);
  assert.equal(checks, 12);
});

test("numeric preflight and unknown-construct checks precede the permissive legacy parser", async () => {
  const base = JSON.parse(await readFile("scenarios/live-match.json", "utf8"));
  base.timeline[0].payload.precise = "NUMBER";
  assert.throws(
    () =>
      conversionInput(
        JSON.stringify(base).replace('"NUMBER"', "0.10000000000000001"),
      ),
    /rounding/,
  );
  assert.throws(
    () =>
      conversionInput(
        JSON.stringify(base).replace('"NUMBER"', "9007199254740993"),
      ),
    /rounding/,
  );
  assert.throws(
    () => conversionInput(JSON.stringify(base).replace('"NUMBER"', "1e400")),
    /rounding/,
  );
  assert.throws(
    () => conversionInput('{"name":"one","name":"two"}'),
    /invalid-json/,
  );
  const unknown = { ...base, ignoredFeature: true };
  assert.throws(
    () => conversionInput(JSON.stringify(unknown)),
    /unsupported field/,
  );
  delete base.timeline[0].payload.precise;
  for (const extra of [
    { fact: { birthSequence: 1 } },
    { expectedRejection: "unknownEpoch" },
  ]) {
    const changed = structuredClone(base);
    Object.assign(changed.timeline[0], extra);
    assert.throws(
      () => conversionInput(JSON.stringify(changed)),
      /unsupported field/,
    );
  }
  base.timeline[0].epoch = "other";
  assert.throws(
    () => conversionInput(JSON.stringify(base)),
    /ordinary configuration uses epoch/,
  );
});

test("exactly represented unsafe integers are rejected while the safe boundary remains admissible", async () => {
  const input = JSON.parse(await readFile("scenarios/live-match.json", "utf8"));
  input.timeline[0].payload.boundary = Number.MAX_SAFE_INTEGER;
  assert.doesNotThrow(() => conversionInput(JSON.stringify(input)));
  input.timeline[0].payload.boundary = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => conversionInput(JSON.stringify(input)), /unsafe integer/);
  delete input.timeline[0].payload.boundary;
  input.timeline[2].expected.boundary = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => conversionInput(JSON.stringify(input)), /unsafe integer/);
});

test("ambiguous same-time order, repeated identities and unsupported client semantics fail explicitly", async () => {
  const base = JSON.parse(await readFile("scenarios/live-match.json", "utf8"));
  const burst = structuredClone(base);
  burst.timeline[1].simulationTime = 0;
  assert.throws(
    () => conversionInput(JSON.stringify(burst)),
    /multiple publications/,
  );
  const interleaved = structuredClone(base);
  interleaved.timeline[3].simulationTime = 250;
  assert.throws(
    () => conversionInput(JSON.stringify(interleaved)),
    /check precedes/,
  );
  const repeated = structuredClone(base);
  repeated.timeline.push({ ...base.timeline[0], simulationTime: 2000 });
  assert.throws(
    () => conversionInput(JSON.stringify(repeated)),
    /repeated publication identity/,
  );
  const absent = structuredClone(base);
  absent.timeline[2].expected = null;
  assert.throws(() => conversionInput(JSON.stringify(absent)), /absence/);
  const disconnected = structuredClone(base);
  disconnected.clients[0].initialState = "disconnected";
  const doc = JSON.parse(
    conversionDocument(
      JSON.stringify(disconnected),
      boundedConfiguration(JSON.stringify(disconnected)),
      options,
    ).canonical,
  );
  assert.ok(
    doc.actors.some((actor: { id: string }) => actor.id === "client-0"),
  );
  assert.ok(
    doc.actions.every(
      (action: { actor: string }) => action.actor !== "client-0",
    ),
  );
});

test("finite-input checks use sequence distance and conservative history/stream bounds", async () => {
  const gap = await readFile("scenarios/sequence-gap.json", "utf8");
  const configuration = JSON.parse(boundedConfiguration(gap));
  const implicitDelivery = structuredClone(configuration);
  delete implicitDelivery.delivery;
  assert.throws(
    () =>
      checkConversionResources(
        conversionInput(gap),
        JSON.stringify(implicitDelivery),
      ),
    /supply this selected delivery bound explicitly/,
  );
  configuration.identityWindow = 3;
  const assessment = checkConversionResources(
    conversionInput(gap),
    JSON.stringify(configuration),
  );
  assert.equal(assessment.finiteInput.streams[0].sequenceSpan, 3);
  configuration.identityWindow = 2;
  assert.throws(
    () =>
      checkConversionResources(
        conversionInput(gap),
        JSON.stringify(configuration),
      ),
    /sequence span/,
  );
  configuration.identityWindow = 20;
  configuration.maxHistoryEntries = 2;
  assert.throws(
    () =>
      checkConversionResources(
        conversionInput(gap),
        JSON.stringify(configuration),
      ),
    /history contribution/,
  );
  const sparse = JSON.parse(gap);
  const sends = sparse.timeline.filter(
    (entry: { kind: string }) => entry.kind === "source-event",
  );
  [1, 100, 2].forEach((sequence, i) => {
    sends[i].publicationSequence = sequence;
  });
  assert.throws(
    () =>
      checkConversionResources(
        conversionInput(JSON.stringify(sparse)),
        boundedConfiguration(gap),
      ),
    /sequence span/,
  );
  const entities = await readFile(
    "scenarios/shared-sequence-across-entities.json",
    "utf8",
  );
  const oneStream = {
    ...JSON.parse(boundedConfiguration(entities)),
    maxStreams: 1,
  };
  assert.throws(
    () =>
      checkConversionResources(
        conversionInput(entities),
        JSON.stringify(oneStream),
      ),
    /distinct stream count/,
  );
});

test("invalid numeric input leaves no output and does not attempt the missing prepared host", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "timeline-conversion-reject-"),
  );
  try {
    const legacy = await readFile("scenarios/live-match.json", "utf8");
    const input = join(directory, "legacy.json");
    const runtime = join(directory, "runtime.json");
    await writeFile(
      input,
      legacy.replace('"home": 0', '"home": 9007199254740993'),
    );
    await writeFile(runtime, boundedConfiguration(legacy));
    const output = join(directory, "output");
    await assert.rejects(
      convertLegacyScenario(input, output, {
        ...options,
        runtime,
        jar: join(directory, "missing.jar"),
      }),
      /rounding/,
    );
    await assert.rejects(stat(output), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prepared-host conversion writes exact inputs, valid provenance and no executable-looking failed result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timeline-conversion-"));
  try {
    const legacy = await readFile("scenarios/late-update.json", "utf8");
    const input = join(directory, "input.json");
    const runtime = join(directory, "runtime.json");
    const configuration = `\n${boundedConfiguration(legacy)}\n`;
    await writeFile(input, legacy);
    await writeFile(runtime, configuration);
    const jar = resolve(
      process.env.ZOOGLASS_SIMULATION_JAR ??
        "../zooglass/simulation-host/target/zooglass-simulation.jar",
    );
    const output = join(directory, "output");
    const result = await convertLegacyScenario(input, output, {
      ...options,
      runtime,
      jar,
    });
    assert.equal(result.execution, "not-run");
    assert.deepEqual((await readdir(output)).sort(), [
      "configuration.json",
      "conversion-report.json",
      "legacy.json",
      "scenario.json",
    ]);
    assert.equal(await readFile(join(output, "legacy.json"), "utf8"), legacy);
    assert.equal(
      await readFile(join(output, "configuration.json"), "utf8"),
      configuration,
    );
    const scenario = parseTimelineDocument(
      await readFile(result.scenario, "utf8"),
    );
    assert.ok(
      await loadConversionProvenance(result.scenario, scenario, configuration),
    );
    const existing = join(directory, "existing");
    await mkdir(existing);
    await writeFile(join(existing, "owned.txt"), "preserve");
    await assert.rejects(
      convertLegacyScenario(input, existing, { ...options, runtime, jar }),
      { code: "EEXIST" },
    );
    assert.equal(
      await readFile(join(existing, "owned.txt"), "utf8"),
      "preserve",
    );
    const changed = JSON.parse(configuration);
    changed.views[0].fields.order.mode = "latestBySequence";
    await writeFile(runtime, JSON.stringify(changed));
    const rejected = join(directory, "different");
    await assert.rejects(
      convertLegacyScenario(input, rejected, { ...options, runtime, jar }),
      /normalized reference/,
    );
    await assert.rejects(stat(rejected), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
