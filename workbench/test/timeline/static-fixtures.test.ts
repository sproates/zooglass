import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import { loadConversionProvenance } from "../../src/timeline/conversion-provenance.js";
import { runDocument } from "../../src/timeline/run-document.js";
import {
  parseReplay,
  replaySaved,
} from "../../src/timeline/replay-document.js";
import { fixture } from "./document-fixture.js";

const root = "scenarios/timeline-static";
const converted = [
  "live-match",
  "late-update",
  "bursty-updates",
  "sequence-gap",
  "shared-sequence-across-entities",
];
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);

test("committed conversions retain exact legacy bytes and all original checks", async () => {
  let publications = 0;
  let checks = 0;
  for (const name of converted) {
    const directory = join(root, name);
    const original = await readFile(`scenarios/${name}.json`, "utf8");
    assert.equal(
      await readFile(join(directory, "legacy.json"), "utf8"),
      original,
    );
    const path = join(directory, "scenario.json");
    const scenario = parseTimelineDocument(await readFile(path, "utf8"));
    const configuration = await readFile(
      join(directory, "configuration.json"),
      "utf8",
    );
    assert.ok(await loadConversionProvenance(path, scenario, configuration));
    // Regeneration validates every mapping and literal expectation, independently
    // of execution. These counts also pin the accepted corpus's breadth.
    const legacy = JSON.parse(original);
    publications += legacy.timeline.filter(
      (entry: { kind: string }) => entry.kind === "source-event",
    ).length;
    checks += legacy.timeline.filter(
      (entry: { kind: string }) => entry.kind === "view-check",
    ).length;
  }
  assert.equal(publications, 20);
  assert.equal(checks, 12);
});

for (const name of [...converted, "mixed-modes"]) {
  test(`reviewed static fixture ${name} passes and replays strictly`, async () => {
    const run = await runDocument(join(root, name, "scenario.json"), { jar });
    assert.equal(run.outcome, "passed", run.message);
    const replay = await replaySaved(parseReplay(JSON.stringify(run)), { jar });
    assert.equal(replay.status, "verified");
    assert.equal(replay.recordedOutcome, "passed");
  });
}

test("maximum family shape executes all three sources, two views and four fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "static-max-shape-"));
  try {
    const field = (sourceId: string, mode: string) => ({
      inputs: [
        { sourceId, type: "sample" },
        { sourceId, type: "corrected" },
      ],
      mode,
    });
    const configuration = {
      contractVersion: 2,
      storage: "memory",
      maxStreams: 20,
      identityWindow: 20,
      maxHistoryEntries: 20,
      sources: ["alpha", "beta", "gamma"].map((id) => ({ id, epoch: "run" })),
      views: [
        {
          id: "combined",
          fields: {
            arrival: field("alpha", "arrival"),
            latest: field("beta", "latestBySequence"),
            history: field("gamma", "historyBySequence"),
          },
        },
        {
          id: "mirror",
          fields: { latest: field("alpha", "latestBySequence") },
        },
      ],
      delivery: { maxQueuedMessages: 128, maxQueuedBytes: 1048576 },
    };
    const wire = JSON.stringify(configuration);
    const actors = ["alpha", "beta", "gamma"];
    const input = fixture().document;
    const document = {
      ...input,
      format: "timeline-simulation/v3",
      id: "static-maximum-shape",
      runtime: {
        ...input.runtime,
        profile: "memory-static-views-v1",
        sha256: createHash("sha256").update(wire).digest("hex"),
      },
      actors: actors.map((id) => ({ id, role: "source" })),
      links: actors.map((actor) => ({ actor, latencyMs: 0 })),
      observationTargets: [
        { viewId: "combined", entityId: "unit" },
        { viewId: "mirror", entityId: "unit" },
      ],
      publications: actors.map((sourceId, i) => ({
        id: `publication-${i}`,
        body: {
          sourceId,
          epoch: "run",
          sourceEntityId: "unit",
          publicationSequence: 1,
          type: i === 1 ? "corrected" : "sample",
          payload: { value: i + 1 },
        },
      })),
      actions: [
        ...actors.map((actor) => ({
          id: `connect-${actor}`,
          atMs: 0,
          kind: "connect",
          actor,
        })),
        ...actors.map((actor, i) => ({
          id: `send-${i}`,
          atMs: i + 1,
          kind: "source-send",
          actor,
          publication: `publication-${i}`,
        })),
      ],
      assertions: [
        ...actors.map((actor, i) => ({
          id: `accepted-${i}`,
          atMs: i + 1,
          kind: "source-accepted",
          actor,
          send: `send-${i}`,
        })),
        {
          id: "combined-data",
          atMs: 3,
          kind: "runtime-data",
          viewId: "combined",
          entityId: "unit",
          expected: {
            arrival: { value: 1 },
            latest: { value: 2 },
            history: [{ value: 3 }],
          },
        },
        {
          id: "mirror-data",
          atMs: 3,
          kind: "runtime-data",
          viewId: "mirror",
          entityId: "unit",
          expected: { latest: { value: 1 } },
        },
      ],
      untilMs: 3,
    };
    await writeFile(join(directory, "runtime.json"), wire);
    const path = join(directory, "scenario.json");
    await writeFile(path, JSON.stringify(document));
    const run = await runDocument(path, { jar });
    assert.equal(run.outcome, "passed", run.message);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
