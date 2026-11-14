import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildDocument,
  configurationSha256,
  documentWire,
  framesAt,
} from "../../scenarios/timeline-sports/author.js";
import {
  inputs,
  pinnedSteps,
  views,
  type PublicationInput,
} from "../../scenarios/timeline-sports/inputs.js";
import { receipt } from "../../scenarios/timeline-sports/receipts.js";
import { rows, state } from "../../scenarios/timeline-sports/states.js";
import { snapshot } from "../../scenarios/timeline-sports/wire.js";
import { canonicalJson } from "../../src/timeline/json.js";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import { runDocument } from "../../src/timeline/run-document.js";
const directory = resolve("scenarios/timeline-sports");
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
const digest = (wire: string | Buffer) =>
  createHash("sha256").update(wire).digest("hex");

test("authored Sports ordinary document preserves all pinned two-cycle inputs and independent boundary states", async () => {
  // Independent export from ad04db982cf32e4f26919a7ffbbb042e48212a78,
  // Date.now replaced by epoch + yielded-step-index *3000 before each next().
  assert.equal(
    digest(canonicalJson(JSON.stringify(pinnedSteps())) + "\n"),
    "91b6d669078728c29aea38a748c57882bdc08fdd3260301e47081a33c654c562",
  );
  assert.equal(pinnedSteps().length, 121);
  assert.equal(
    digest(await readFile(join(directory, "runtime.json"))),
    configurationSha256,
  );
  assert.equal(
    await readFile(join(directory, "scenario.json"), "utf8"),
    documentWire(),
  );
  const document = buildDocument(),
    all = inputs(),
    sends = all.filter(
      (input): input is PublicationInput => input.kind === "publication",
    );
  assert.equal(
    parseTimelineDocument(JSON.stringify(document)).profile,
    "sqlite-sports-v1",
  );
  assert.equal(sends.length, 114);
  assert.equal(document.publications.length, 99);
  assert.equal(
    document.actions.filter((action) => action.kind === "source-retry").length,
    15,
  );
  assert.equal(
    document.actions.filter((action) => action.kind === "connect").length,
    7,
  );
  assert.equal(
    document.actions.filter((action) => action.kind === "progress-send").length,
    6,
  );
  assert.equal(
    document.actions.filter((action) => action.kind === "retirement-send")
      .length,
    9,
  );
  assert.equal(document.observationTargets.length, 9);
  assert.equal(document.assertions.length, 193);
  assert.equal(framesAt(document.untilMs).length, 105);
  const bodies = new Map(
    document.publications.map((publication) => [
      publication.id,
      publication.body,
    ]),
  );
  const emitted = document.actions.filter(
    (action) => action.kind === "source-send" || action.kind === "source-retry",
  );
  assert.deepEqual(
    emitted.map((action) => ({
      atMs: action.atMs,
      body: bodies.get(
        (action as unknown as { publication: string }).publication,
      ),
    })),
    sends.map((input) => ({ atMs: input.atMs, body: input.body })),
  );
  for (const duplicate of sends.filter((input) => input.duplicate)) {
    const original = sends.find(
      (input) =>
        input.atMs < duplicate.atMs &&
        canonicalJson(JSON.stringify(input.body)) ===
          canonicalJson(JSON.stringify(duplicate.body)),
    )!;
    assert.deepEqual(receipt(duplicate), {
      ...receipt(original),
      status: "duplicate",
      reason: "alreadyCommitted",
      changedViews: [],
    });
  }
  const expected = (id: string, viewId = "match-market") =>
    snapshot(
      viewId,
      state(
        rows.find((row) => row.id === id)!,
        viewId,
      ),
    );
  assert.equal("homeScore" in expected("metadata").data, false);
  assert.equal(expected("all-goals-withdrawn").data.homeScore, 0);
  assert.equal(
    expected("all-goals-withdrawn").status.fields.homeScore.facts?.activeCount,
    1,
  );
  assert.equal(expected("retired-all-views").data.homeScore, 0);
  assert.equal(
    expected("retired-all-views").status.fields.homeScore.facts?.activeCount,
    0,
  );
  assert.equal(
    expected("retired-all-views").status.fields.homeScore.facts
      ?.minimumBirthSequence,
    14,
  );
  assert.equal(expected("withdrawal", "first-reported").data.homeScore, 2);
  assert.equal(expected("withdrawal").data.homeScore, 1);
  assert.equal(
    expected("unknown-correction-no-progress").status.inputs["match-feed"]
      .observedThrough,
    4,
  );
  assert.equal(
    expected("market-at-deadline").status.fields.market.freshness,
    "stale",
  );
});

test("prepared Sports runtime satisfies all authored two-cycle receipts, values, facts, progress and frames", async () => {
  const diagnosticDirectory = await mkdtemp(
    join(tmpdir(), "sports-ordinary-positive-"),
  );
  try {
    const run = await runDocument(join(directory, "scenario.json"), {
      jar,
      diagnosticDirectory,
    });
    assert.equal(
      run.outcome,
      "passed",
      run.message ?? "Sports ordinary run failed",
    );
    const records = run.trace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const initialized = records.find(
      (record) => record.kind === "runtime-initialized",
    );
    assert.deepEqual(
      initialized.data.snapshots,
      ["match-1", "match-2", "match-3"].flatMap((entityId) =>
        views.map((view) =>
          snapshot(view, { ...state(rows[0], view), entityId }),
        ),
      ),
    );
    assert.equal(records.at(-1).pendingMessages, 0);
    assert.equal(records.at(-1).heldFrames, 0);
    assert.equal(records.at(-1).pendingFutureTasks, 1);
  } finally {
    await rm(diagnosticDirectory, { recursive: true, force: true });
  }
});

test("Sports oracles reject mutated first-reported collections, absent retired scores and progress from an unknown fact", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "sports-ordinary-negative-"));
  try {
    await writeFile(
      join(temporary, "runtime.json"),
      await readFile(join(directory, "runtime.json")),
    );
    const original = buildDocument();
    const observed = (id: string, view: string) =>
      structuredClone(
        snapshot(
          view,
          state(
            rows.find((row) => row.id === id)!,
            view,
          ),
        ),
      );
    const wrongFirst = observed("corrected-scorer", "first-reported");
    const collection = wrongFirst.data.homeGoals as {
      revision: number;
      payload: { scorer?: string };
    }[];
    collection[2].revision = 2;
    collection[2].payload.scorer = "Taylor Brook";
    const wrongAbsent = observed("retired-all-views", "match-market");
    delete wrongAbsent.data.homeScore;
    delete wrongAbsent.provenance.homeScore;
    wrongAbsent.status.missingFields.push("homeScore");
    wrongAbsent.status.missingFields.sort();
    wrongAbsent.status.publication = "partial";
    wrongAbsent.status.fields.homeScore.freshness = "absent";
    const wrongProgress = observed(
      "unknown-correction-no-progress",
      "match-market",
    );
    wrongProgress.status.inputs["match-feed"].observedThrough = 6;
    const cases = [
      {
        id: "first-reported-keeps-original-scorer",
        atMs: 54010,
        viewId: "first-reported",
        snapshot: wrongFirst,
      },
      {
        id: "retired-score-is-present-empty-window",
        atMs: 168012,
        viewId: "match-market",
        snapshot: wrongAbsent,
      },
      {
        id: "unknown-fact-cannot-advance-progress",
        atMs: 36010,
        viewId: "match-market",
        snapshot: wrongProgress,
      },
    ];
    for (const wrong of cases) {
      const assertion = {
        id: wrong.id,
        atMs: wrong.atMs,
        kind: "runtime-snapshot",
        viewId: wrong.viewId,
        entityId: "match-1",
        expected: { outcome: "available", snapshot: wrong.snapshot },
      };
      const document = { ...original, assertions: [assertion] };
      assert.doesNotThrow(() =>
        parseTimelineDocument(JSON.stringify(document)),
      );
      const path = join(temporary, `${wrong.id}.json`);
      await writeFile(path, JSON.stringify(document));
      const run = await runDocument(path, {
        jar,
        diagnosticDirectory: temporary,
      });
      assert.equal(run.outcome, "assertion-failed");
      assert.equal(run.message, `assertion-failed: ${wrong.id}`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
