import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditExplanationSafety } from "../../scripts/explanation-safety.js";
import { canonicalJson } from "../../src/timeline/json.js";
import { fixture, receipt, source } from "./document-fixture.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// Small authored evidence fixture for the offline checker, not an execution witness.
async function safetyBundle(root: string) {
  const directory = join(root, "bundle");
  await mkdir(directory);
  const input = fixture();
  const configuration = JSON.stringify({
    ...input.configuration,
    views: [
      {
        id: "stock-view",
        fields: {
          reading: {
            sourceId: "warehouse-feed",
            type: "stock",
            mode: "arrival",
          },
        },
      },
    ],
  });
  const configHash = sha(configuration);
  const scenario = canonicalJson(
    JSON.stringify({
      ...input.document,
      format: "timeline-simulation/v5",
      runtime: {
        ...input.document.runtime,
        sha256: configHash,
        profile: "static-views-restart-v1",
      },
      observationTargets: [],
      actions: [
        { id: "connect", atMs: 0, kind: "connect", actor: source },
        {
          id: "send",
          atMs: 1,
          kind: "source-send",
          actor: source,
          publication: "report-1",
        },
      ],
      assertions: [],
      untilMs: 1,
    }),
  );
  const execution = {
    profile: "static-views-restart-v1",
    artifactSha256: "a".repeat(64),
    configurationSha256: configHash,
    workbenchSha256: "b".repeat(64),
  };
  const event = (
    eventId: string,
    kind: string,
    parentId: string | null,
    key: number[],
    actor: string,
    runtimeGeneration: number | null,
    connectionGeneration: number | null,
    data: unknown,
  ) => ({
    eventId,
    kind,
    parentId,
    key,
    actor,
    runtimeGeneration,
    connectionGeneration,
    data,
  });
  const applied = receipt(1, 1);
  const trace = [
    {
      format: "timeline-trace/v5",
      scenarioSha256: sha(scenario),
      untilMs: 1,
      execution,
    },
    event(
      "init",
      "runtime-command",
      null,
      [0, 0, 0, 0],
      "@runtime",
      null,
      null,
      {
        op: "initialize-document",
        configurationSha256: configHash,
        epochMillis: input.document.clock.epochMillis,
      },
    ),
    event(
      "started",
      "runtime-initialized",
      "init",
      [0, 0, 0, 0],
      "@runtime",
      1,
      null,
      {
        startTimeMs: 0,
        wallMillis: input.document.clock.epochMillis,
        monotonicMs: 0,
        snapshots: [],
        projectedSnapshots: [],
      },
    ),
    event("connect", "action", null, [0, 0, 1, 1], source, 1, 1, {
      actionId: "connect",
      actionKind: "connect",
    }),
    event("send", "action", null, [1, 0, 1, 2], source, 1, 1, {
      actionId: "send",
      actionKind: "source-send",
      publication: "report-1",
    }),
    event("receipt", "receipt", "send", [1, 0, 1, 2], source, 1, 1, {
      envelope: applied,
      messageId: "message-0",
    }),
    event(
      "decision",
      "publication-decision",
      "send",
      [1, 0, 1, 2],
      source,
      1,
      1,
      {
        envelope: {
          availability: "recorded",
          decision: {
            format: "publication-decision/v1",
            stream: applied.stream,
            publicationSequence: 1,
            status: "applied",
            reason: "memory",
            version: 1,
            installed: true,
            targets: [
              {
                viewId: "stock-view",
                entityId: "sku-4",
                fields: [
                  {
                    field: "reading",
                    strategy: "arrival",
                    update: "ARRIVAL_REPLACED",
                    retainedChanged: true,
                    publicChanged: true,
                  },
                ],
              },
            ],
          },
        },
      },
    ),
    event("delivered", "delivered", "receipt", [1, 0, 2, 3], source, 1, 1, {
      channel: "source-receipt",
      envelope: applied,
      messageId: "message-0",
    }),
    {
      kind: "result",
      outcome: "passed",
      eventCount: 7,
      pendingFutureTasks: 0,
      pendingMessages: 0,
      heldFrames: 0,
    },
  ]
    .map((record) => canonicalJson(JSON.stringify(record)) + "\n")
    .join("");
  const environment = { executor: "static-views-restart-v1/1" };
  const files = {
    "scenario.json": scenario,
    "configuration.json": configuration,
    "trace.jsonl": trace,
    "run.json": JSON.stringify({
      format: "timeline-run/v5",
      environment,
      outcome: "passed",
      scenario,
      configuration,
      execution,
      trace,
    }),
  };
  const manifest = JSON.stringify({
    format: "timeline-bundle/v5",
    versions: {
      scenario: "timeline-simulation/v5",
      trace: "timeline-trace/v5",
      scheduler: "time-round-phase-ordinal/v1",
      randomness: "sha256-length-prefixed/v1",
      protocol: 2,
    },
    source: { revision: null, trackedChanges: null },
    initialState: { storage: "memory", state: "empty" },
    outcome: "passed",
    execution,
    environment,
    files: Object.fromEntries(
      Object.entries(files).map(([name, value]) => [
        name,
        { bytes: Buffer.byteLength(value), sha256: sha(value) },
      ]),
    ),
  });
  for (const [name, bytes] of Object.entries({
    ...files,
    "manifest.json": manifest,
  }))
    await writeFile(join(directory, name), bytes);
  return { directory, manifest };
}

test("offline safety audit exercises exact negative controls and preserves original evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "explanation-safety-"));
  try {
    const { directory, manifest } = await safetyBundle(root);
    const result = await auditExplanationSafety(
      directory,
      join(root, "scratch"),
    );
    assert.equal(result.format, "timeline-explanation-safety/v1");
    assert.equal(result.input.manifestSha256, sha(manifest));
    assert.deepEqual(
      result.checks.map((check) => check.name),
      [
        "corrupted-trace-hash",
        "recomputed-missing-decision",
        "recomputed-duplicate-decision",
        "output-inside-evidence",
        "output-through-symlink-parent",
        "existing-output",
        "unknown-event",
        "entry-limit",
        "text-byte-limit",
        "json-byte-limit",
        "terminal-control-escaping",
      ],
    );
    assert.ok(result.checks.every((check) => check.passed));
    assert.deepEqual(await readdir(root), ["bundle"]);
    assert.equal(
      await readFile(join(directory, "manifest.json"), "utf8"),
      manifest,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safety audit does not own pre-existing or contained scratch directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "explanation-safety-"));
  try {
    const { directory } = await safetyBundle(root);
    const scratch = join(root, "owned-by-caller");
    await mkdir(scratch);
    await writeFile(join(scratch, "keep"), "unchanged");
    await assert.rejects(auditExplanationSafety(directory, scratch), /EEXIST/);
    assert.equal(await readFile(join(scratch, "keep"), "utf8"), "unchanged");
    await assert.rejects(
      auditExplanationSafety(directory, join(directory, "scratch")),
      /outside the original bundle/,
    );
    assert.ok(!(await readdir(directory)).includes("scratch"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
