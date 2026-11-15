import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { runDocument } from "../../src/timeline/run-document.js";
import { replayDocument } from "../../src/timeline/replay-document.js";
import { parseTrace } from "../../src/timeline/trace-contract.js";
import {
  recordBundle,
  replayBundle,
} from "../../src/timeline/artifact-bundle.js";
import { action } from "./document-fixture.js";
import {
  retirement,
  retirementActor,
  retirementAck,
  retirementAssertion,
  sportsDocument,
  sportsFiles,
} from "./sports-document-fixture.js";
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
const records = (trace: string) =>
  trace
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));

test("Sports retirement preserves complete acknowledgements, partial-view commits and exact replay", async (t) => {
  const doc = sportsDocument();
  const other = { ...retirement, viewId: "first-reported" };
  const rejected = { ...retirement, fields: ["awayScore", "match"] };
  doc.actions.push(
    action("other", 17, "retirement-send", retirementActor, { control: other }),
    action("invalid-field", 24, "retirement-send", retirementActor, {
      control: rejected,
    }),
    action("repeat", 31, "retirement-send", retirementActor, {
      control: retirement,
    }),
  );
  doc.untilMs = 40;
  doc.assertions = [
    retirementAssertion("before", 15, []),
    retirementAssertion("first", 16, [retirementAck()]),
    retirementAssertion("all", 40, [
      retirementAck(),
      retirementAck("committed", 2, other),
      {
        kind: "factRetirement",
        status: "rejected",
        reason: "unknownFactField",
        control: rejected,
        version: 2,
        floors: {},
        changedViews: [],
      },
      retirementAck("unchanged", 2),
    ]),
  ];
  const input = await sportsFiles(doc);
  t.after(input.close);
  const run = await runDocument(input.path, { jar });
  assert.equal(run.outcome, "passed", run.message ?? "");
  const events = records(run.trace);
  assert.equal(events.filter((e) => e.kind === "state").length, 2);
  const saved = join(input.directory, "run.json");
  await writeFile(saved, JSON.stringify(run));
  const replay = await replayDocument(saved, { jar, hostDelay: 1 });
  assert.equal(replay.status, "verified");
  assert.equal(replay.actual.trace, run.trace);
  for (const mutate of [
    (e: ReturnType<typeof records>) => {
      e[0].execution.profile = "sqlite-order-v1";
    },
    (e: ReturnType<typeof records>) => {
      e.find(
        (x) => x.kind === "control-receipt",
      ).data.envelope.control.entityId = "other";
    },
    (e: ReturnType<typeof records>) => {
      e.find(
        (x) =>
          x.kind === "link-send" && x.data.channel === "retirement-request",
      ).data.channel = "progress-request";
    },
    (e: ReturnType<typeof records>) => {
      e.find((x) => x.kind === "control-receipt").connectionGeneration = 2;
    },
  ]) {
    const changed = records(run.trace);
    mutate(changed);
    assert.throws(() =>
      parseTrace(changed.map((e) => JSON.stringify(e)).join("\n") + "\n"),
    );
  }
});

test("Sports connection closure cancels requests or only acknowledgements after commit", async (t) => {
  for (const closeAt of [12, 13, 14, 16]) {
    const doc = sportsDocument();
    doc.actions.push(
      action("close", closeAt, "disconnect", retirementActor),
      action("reconnect", closeAt + 1, "connect", retirementActor),
      action("repeat", closeAt + 2, "retirement-send", retirementActor, {
        control: retirement,
      }),
    );
    doc.assertions = [
      retirementAssertion("replacement", 25, [
        retirementAck(closeAt <= 13 ? "committed" : "unchanged"),
      ]),
    ];
    const input = await sportsFiles(doc);
    t.after(input.close);
    const run = await runDocument(input.path, { jar });
    assert.equal(run.outcome, "passed", run.message ?? "");
    const events = records(run.trace);
    assert.equal(events.filter((e) => e.kind === "state").length, 1);
    assert.equal(
      events.find((e) => e.kind === "dropped").data.channel,
      closeAt <= 13 ? "retirement-request" : "retirement-receipt",
    );
    assert.equal(
      events.find(
        (e) =>
          e.kind === "delivered" && e.data.channel === "retirement-receipt",
      ).connectionGeneration,
      2,
    );
  }
});

test("Sports malformed retirement remains a production rejection and bundles strictly replay", async (t) => {
  const doc = sportsDocument(0);
  doc.actions.push(
    action("malformed", 11, "retirement-send", retirementActor, {
      control: {},
    }),
  );
  doc.assertions = [
    retirementAssertion("all", 25, [
      retirementAck(),
      {
        kind: "factRetirement",
        status: "rejected",
        reason: "invalidFactRetirement",
        control: null,
        version: null,
        floors: {},
        changedViews: [],
      },
    ]),
  ];
  const input = await sportsFiles(doc);
  t.after(input.close);
  const bundle = join(input.directory, "bundle");
  assert.equal(
    (await recordBundle(input.path, bundle, { jar })).outcome,
    "passed",
  );
  const replay = await replayBundle(bundle, { jar });
  assert.equal(replay.status, "verified");
  assert.equal(replay.recordedOutcome, "passed");
});

test("same-time fact publication and retirement follow declaration order", async (t) => {
  for (const retireFirst of [false, true]) {
    const doc = sportsDocument(0);
    const source = "match-source";
    doc.actors.push({ id: source, role: "source" });
    doc.links.push({ actor: source, latencyMs: 0 });
    const body = {
      sourceId: "match-feed",
      epoch: "run",
      sourceEntityId: "match-1",
      publicationSequence: 1,
      type: "home.contribution",
      fact: { birthSequence: 1, revision: 1, operation: "create" },
      payload: { points: 1 },
    };
    const control = {
      viewId: "match-market",
      entityId: "match-1",
      fields: ["homeGoals", "homeScore"],
      minimumBirthSequence: 2,
    };
    const operations = [
      action("fact", 10, "source-send", source, { publication: "goal" }),
      action("retire", 10, "retirement-send", retirementActor, { control }),
    ];
    doc.actions = [
      action("connect", 0, "connect", retirementActor),
      action("source-connect", 0, "connect", source),
      ...(retireFirst ? operations.reverse() : operations),
    ];
    doc.assertions = [
      retirementAssertion("retirement", 25, [
        retirementAck("committed", retireFirst ? 1 : 2, control),
      ]),
    ];
    const input = await sportsFiles(doc);
    t.after(input.close);
    // Supply the same literal publication in both schedules, with no generated expectation.
    await writeFile(
      input.path,
      JSON.stringify({ ...doc, publications: [{ id: "goal", body }] }),
    );
    const run = await runDocument(input.path, { jar });
    assert.equal(run.outcome, "passed", run.message ?? "");
    const events = records(run.trace);
    const receipt = events.find((e) => e.kind === "receipt").data.envelope;
    const views = ["match-market", "scoreboard", "first-reported"];
    assert.deepEqual(receipt, {
      status: "committed",
      reason: "sqlite",
      stream: {
        sourceId: "match-feed",
        epoch: "run",
        sourceEntityId: "match-1",
      },
      publicationSequence: 1,
      version: retireFirst ? 2 : 1,
      changedViews: views,
      targets: views.map((viewId) => {
        const rejected = retireFirst && viewId === "match-market";
        const fields =
          viewId === "scoreboard" ? ["homeScore"] : ["homeGoals", "homeScore"];
        return {
          viewId,
          entityId: "match-1",
          status: rejected ? "rejected" : "accepted",
          reason: rejected ? "factOutsideRetention" : null,
          changedFields: rejected ? [] : fields,
          fields: fields.map((field) => ({
            field,
            status: rejected ? "rejected" : "accepted",
            reason: rejected ? "factOutsideRetention" : null,
            changed: !rejected,
          })),
        };
      }),
    });
    assert.deepEqual(
      events
        .filter(
          (e) =>
            e.kind === "action" &&
            ["source-send", "retirement-send"].includes(e.data.actionKind),
        )
        .map((e) => e.data.actionKind),
      retireFirst
        ? ["retirement-send", "source-send"]
        : ["source-send", "retirement-send"],
    );
  }
});
