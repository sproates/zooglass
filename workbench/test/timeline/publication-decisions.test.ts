import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixture, source } from "./document-fixture.js";
import {
  recordBundle,
  readBundle,
} from "../../src/timeline/artifact-bundle.js";
import {
  parseReplay,
  replaySaved,
} from "../../src/timeline/replay-document.js";
import { encodeJson, parseJson } from "../../src/timeline/json.js";
import {
  explainBundle,
  writeExplanation,
} from "../../src/explanation/reader.js";
import { renderExplanation } from "../../src/explanation/render.js";
import { runDocument } from "../../src/timeline/run-document.js";
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);

async function input(storage: "memory" | "sqlite") {
  const directory = await mkdtemp(join(tmpdir(), "decision-evidence-"));
  const base = fixture();
  const configuration = {
    ...base.configuration,
    storage,
    views: [
      {
        id: "stock-view",
        fields: {
          arrival: {
            sourceId: "warehouse-feed",
            type: "stock",
            mode: "arrival",
          },
          latest: {
            sourceId: "warehouse-feed",
            type: "stock",
            mode: "latestBySequence",
          },
          history: {
            sourceId: "warehouse-feed",
            type: "stock",
            mode: "historyBySequence",
          },
        },
      },
    ],
  };
  const wire = JSON.stringify(configuration);
  const document = {
    ...base.document,
    format: "timeline-simulation/v5",
    id: `decisions-${storage}`,
    runtime: {
      ...base.document.runtime,
      storage,
      profile: "static-views-restart-v1",
      sha256: createHash("sha256").update(wire).digest("hex"),
    },
    observationTargets: [{ viewId: "stock-view", entityId: "sku-4" }],
    actions: [
      { id: "connect", atMs: 0, actor: source, kind: "connect" },
      {
        id: "newer",
        atMs: 1,
        actor: source,
        kind: "source-send",
        publication: "report-2",
      },
      {
        id: "older",
        atMs: 2,
        actor: source,
        kind: "source-send",
        publication: "report-1",
      },
      {
        id: "retry",
        atMs: 3,
        actor: source,
        kind: "source-retry",
        publication: "report-1",
      },
      { id: "stop", atMs: 4, kind: "service-stop", mode: "abrupt" },
      { id: "start", atMs: 5, kind: "service-start" },
      { id: "reconnect", atMs: 6, actor: source, kind: "connect" },
      {
        id: "reapply",
        atMs: 7,
        actor: source,
        kind: "source-retry",
        publication: "report-1",
      },
      {
        id: "retry-again",
        atMs: 8,
        actor: source,
        kind: "source-retry",
        publication: "report-1",
      },
    ],
    assertions: [
      {
        id: "latest",
        atMs: 8,
        kind: "runtime-data",
        viewId: "stock-view",
        entityId: "sku-4",
        expected: {
          arrival: { amount: 1 },
          latest: { amount: storage === "memory" ? 1 : 2 },
          history:
            storage === "memory"
              ? [{ amount: 1 }]
              : [{ amount: 1 }, { amount: 2 }],
        },
      },
    ],
    untilMs: 8,
  };
  await writeFile(join(directory, "runtime.json"), wire);
  const path = join(directory, "scenario.json");
  await writeFile(path, JSON.stringify(document));
  return { directory, path, document };
}

type MutableRecord = {
  kind: string;
  eventId: string;
  eventCount: number;
  parentId: string;
  connectionGeneration: number;
  data: {
    envelope: {
      availability?: string;
      reason?: string;
      decision?: { targets: { fields: { field: string; update: string }[] }[] };
    };
  };
};
type Run = Awaited<ReturnType<typeof runDocument>>;
function mutate(run: Run, change: (records: MutableRecord[]) => void) {
  const records = run.trace
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  change(records);
  records.at(-1)!.eventCount = records.length - 2;
  return {
    ...run,
    trace: records
      .map((record) => encodeJson(parseJson(JSON.stringify(record))) + "\n")
      .join(""),
  };
}

for (const storage of ["memory", "sqlite"] as const) {
  test(`V5 ${storage} records real strategy reasons and restart lineage`, async () => {
    const value = await input(storage);
    try {
      const result = await recordBundle(
        value.path,
        join(value.directory, "bundle"),
        { jar },
      );
      assert.equal(result.outcome, "passed", result.message);
      const saved = await readBundle(join(value.directory, "bundle"));
      const report = await explainBundle(join(value.directory, "bundle"));
      assert.equal(report.replayStatus, "not-run");
      assert.equal(report.coverage.recordedDecisionCount, 5);
      assert.match(renderExplanation(report, "text"), /LATEST_OLDER/);
      assert.equal(
        renderExplanation(report, "json"),
        renderExplanation(
          await explainBundle(join(value.directory, "bundle")),
          "json",
        ),
      );
      assert.equal(
        await writeExplanation(
          join(value.directory, "bundle"),
          join(value.directory, "report.txt"),
          "text",
        ),
        0,
      );
      const decisions = saved.trace.publicationDecisions;
      assert.equal(decisions.length, 5);
      const json = decisions.map((entry) =>
        JSON.parse(encodeJson(entry.event.data.envelope)),
      );
      assert.deepEqual(
        json[1].decision.targets[0].fields.map(
          (field: { update: string }) => field.update,
        ),
        ["ARRIVAL_REPLACED", "HISTORY_INSERTED", "LATEST_OLDER"],
      );
      assert.deepEqual(json[2].decision.targets, []);
      assert.equal(json[2].decision.installed, false);
      assert.equal(decisions[2].original, decisions[1].event.id);
      assert.equal(
        decisions[3].original,
        storage === "sqlite" ? decisions[1].event.id : undefined,
      );
      assert.equal(
        decisions[4].original,
        storage === "sqlite" ? decisions[1].event.id : decisions[3].event.id,
      );
      assert.equal((await replaySaved(saved, { jar })).status, "verified");
      const paused = await runDocument(value.path, {
        jar,
        hostDelay: 2,
        jvmPauseMs: 70,
      });
      assert.equal(paused.trace, result.trace, paused.message);
      if (storage === "memory") {
        const changed = mutate(result, (records) => {
          const first = records.find(
            (record) => record.kind === "publication-decision",
          )!;
          first.data.envelope.decision!.targets[0].fields.find(
            (field: { field: string }) => field.field === "latest",
          )!.update = "LATEST_NEWER";
        });
        const alternate = parseReplay(JSON.stringify(changed));
        assert.equal(
          (await replaySaved(alternate, { jar })).status,
          "diverged",
        );
        for (const edit of [
          (records: MutableRecord[]) => {
            records.splice(
              records.findIndex(
                (record) => record.kind === "publication-decision",
              ),
              1,
            );
          },
          (records: MutableRecord[]) => {
            const i = records.findIndex(
              (record) => record.kind === "publication-decision",
            );
            records.splice(i + 1, 0, {
              ...records[i],
              eventId: "duplicate-decision",
            });
          },
          (records: MutableRecord[]) => {
            records.find(
              (record) => record.kind === "publication-decision",
            )!.parentId = "event-0";
          },
          (records: MutableRecord[]) => {
            records.find(
              (record) => record.kind === "publication-decision",
            )!.data.envelope = {
              availability: "unavailable",
              reason: "processingFailure",
            };
          },
          (records: MutableRecord[]) => {
            records.find(
              (record) => record.kind === "publication-decision",
            )!.connectionGeneration = 99;
          },
        ])
          assert.throws(
            () => parseReplay(JSON.stringify(mutate(result, edit))),
            /invalid/,
          );
      }
    } finally {
      await rm(value.directory, { recursive: true, force: true });
    }
  });
}

for (const missingAt of ["inspection", "probe", "restart"] as const) {
  test(`V5 requires decision capability during ${missingAt}`, async (context) => {
    const { Bridge } = await import("../../src/timeline/bridge.js");
    const value = await input("memory");
    const open = Bridge.open;
    let initialized = 0;
    context.mock.method(
      Bridge,
      "open",
      async (...args: Parameters<typeof Bridge.open>) => {
        const opened = await open(...args);
        if (
          (missingAt === "inspection" && !args[3]) ||
          (missingAt === "probe" && args[3]?.runtimeGeneration === 1) ||
          (missingAt === "restart" && args[3]?.runtimeGeneration === 2)
        )
          opened.bridge.publicationDecisions = 0;
        const command = opened.bridge.command.bind(opened.bridge);
        opened.bridge.command = async (...args) => {
          if (args[1].op === "initialize-document") initialized++;
          return command(...args);
        };
        return opened;
      },
    );
    try {
      if (missingAt === "restart") {
        const result = await runDocument(value.path, { jar });
        assert.equal(result.outcome, "infrastructure-failed");
        assert.match(result.message!, /publication decisions/);
        assert.equal(initialized, 1);
      } else {
        await assert.rejects(
          runDocument(value.path, { jar }),
          /publication decisions/,
        );
        assert.equal(initialized, 0);
      }
    } finally {
      await rm(value.directory, { recursive: true, force: true });
    }
  });
}

test("V5 rejected identity conflicts retain no candidate changes and failed assertions remain explainable", async () => {
  const value = await input("memory");
  try {
    value.document.publications[3].body.publicationSequence = 1;
    value.document.actions = value.document.actions.slice(0, 4);
    value.document.actions[3] = {
      id: "conflict",
      atMs: 3,
      actor: source,
      kind: "source-send",
      publication: "report-4",
    };
    // The existing expectation deliberately expects the reset state, but this run does not restart.
    await writeFile(value.path, JSON.stringify(value.document));
    const result = await recordBundle(
      value.path,
      join(value.directory, "bundle"),
      { jar },
    );
    assert.equal(result.outcome, "assertion-failed", result.message);
    const saved = await readBundle(join(value.directory, "bundle"));
    const detail = JSON.parse(
      encodeJson(saved.trace.publicationDecisions[2].event.data.envelope),
    ).decision;
    assert.equal(detail.status, "rejected");
    assert.equal(detail.reason, "identityConflict");
    assert.equal(detail.installed, false);
    assert.deepEqual(detail.targets, []);
    assert.equal(
      await writeExplanation(
        join(value.directory, "bundle"),
        join(value.directory, "report.json"),
        "json",
      ),
      2,
    );
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("V5 malformed input records unavailable detail and remains readable and replayable", async () => {
  const value = await input("memory");
  try {
    const malformed = {
      ...value.document,
      publications: [{ id: "bad", body: {} }],
      actions: [
        value.document.actions[0],
        {
          id: "bad-send",
          atMs: 1,
          actor: source,
          kind: "source-send",
          publication: "bad",
        },
      ],
      assertions: [
        {
          id: "empty",
          atMs: 8,
          kind: "runtime-data",
          viewId: "stock-view",
          entityId: "sku-4",
          expected: {},
        },
      ],
    };
    await writeFile(value.path, JSON.stringify(malformed));
    const result = await recordBundle(
      value.path,
      join(value.directory, "bundle"),
      { jar },
    );
    assert.equal(result.outcome, "passed", result.message);
    const saved = await readBundle(join(value.directory, "bundle"));
    assert.deepEqual(
      JSON.parse(
        encodeJson(saved.trace.publicationDecisions[0].event.data.envelope),
      ),
      { availability: "unavailable", reason: "invalidEnvelope" },
    );
    const report = await explainBundle(join(value.directory, "bundle"));
    assert.match(
      renderExplanation(report, "text"),
      /rejected before publication processing/,
    );
    assert.equal((await replaySaved(saved, { jar })).status, "verified");
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});
