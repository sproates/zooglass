import assert from "node:assert/strict";
import { buildDocument as ordinaryDocument } from "../scenarios/timeline-order/author.js";
import { controlReceipts as ordinaryControls } from "../scenarios/timeline-order/receipts.js";
import {
  buildDocument as recoveryDocument,
  recoverySnapshots,
} from "../scenarios/timeline-order-recovery/author.js";
import {
  variants,
  type Variant,
} from "../scenarios/timeline-order-recovery/inputs.js";
import { watermark } from "../scenarios/timeline-order-recovery/oracle.js";
import {
  buildDocument as retentionDocument,
  controlReceipts as retentionControls,
} from "../scenarios/timeline-order-retention/author.js";
import { snapshot as retentionSnapshot } from "../scenarios/timeline-order-retention/oracle.js";
import type {
  CampaignMode,
  DocumentRun,
} from "../src/timeline/campaign-checks.js";
import { canonicalJson, encodeJson } from "../src/timeline/json.js";
import { integer } from "../src/timeline/validation.js";
import { restartEvidence } from "./restart-campaign-evidence.js";

export type OrderGroup = "ordinary" | "before" | "at" | "after" | "retention";
export type OrderCounts = {
  group: OrderGroup;
  records: number;
  assertions: number;
  receipts: number;
  controls: number;
  frames: number;
  generations: {
    start: number;
    commands: number;
    state: number;
    writer: number;
    alarm?: number;
  }[];
};

// Literal reviewed workload sizes. Command counts include initialization/shutdown,
// delivered commands, scheduled host tasks and installed/settled observations.
// Recovery B's request is cancelled before delivery, so adds no host command.
export const orderCounts: readonly OrderCounts[] = [
  {
    group: "ordinary",
    records: 1908,
    assertions: 129,
    receipts: 183,
    controls: 36,
    frames: 64,
    generations: [
      { start: 0, commands: 580, state: 10, writer: 0, alarm: 24010 },
    ],
  },
  {
    group: "before",
    records: 649,
    assertions: 26,
    receipts: 8,
    controls: 1,
    frames: 68,
    generations: [
      { start: 0, commands: 146, state: 1, writer: 0 },
      { start: 15019, commands: 62, state: 15019, writer: 15019 },
    ],
  },
  {
    group: "at",
    records: 649,
    assertions: 26,
    receipts: 8,
    controls: 1,
    frames: 68,
    generations: [
      { start: 0, commands: 145, state: 1, writer: 0 },
      { start: 15020, commands: 62, state: 15020, writer: 15020 },
    ],
  },
  {
    group: "after",
    records: 865,
    assertions: 44,
    receipts: 14,
    controls: 3,
    frames: 84,
    generations: [
      { start: 0, commands: 145, state: 1, writer: 0 },
      { start: 15023, commands: 140, state: 15036, writer: 15023 },
    ],
  },
  {
    group: "retention",
    records: 416,
    assertions: 60,
    receipts: 15,
    controls: 6,
    frames: 24,
    generations: [
      { start: 0, commands: 100, state: 10, writer: 0 },
      { start: 60, commands: 62, state: 65, writer: 60 },
    ],
  },
];

export function authoredOrderDocument(group: OrderGroup) {
  return group === "ordinary"
    ? ordinaryDocument()
    : group === "retention"
      ? retentionDocument()
      : recoveryDocument(group);
}

const canonical = (value: unknown) => canonicalJson(JSON.stringify(value));

/** Equality is separate from authored correctness, complete evidence and measured perturbation. */
export function checkOrderCampaignRun(
  raw: string,
  baseline: DocumentRun | undefined,
  mode: CampaignMode,
  expected: OrderCounts,
) {
  const { run, parsed, byKind } = restartEvidence(raw, baseline, "sqlite");
  const document = authoredOrderDocument(expected.group);
  assert.equal(
    run.scenario,
    canonical(document),
    "authored Order document identity",
  );
  assert.equal(
    parsed.scenario.profile,
    document.runtime.profile,
    "Order scenario profile",
  );
  assert.equal(
    run.execution.profile,
    document.runtime.profile,
    "Order execution profile",
  );
  assert.equal(
    run.execution.configurationSha256,
    document.runtime.sha256,
    "authored Order configuration identity",
  );
  assert.equal(
    parsed.lines.length,
    expected.records,
    "complete Order record count",
  );
  assert.equal(
    run.diagnostics.retainedStore,
    undefined,
    "passing Order run retained a database",
  );
  assert.match(
    run.environment.java.sqliteVersion,
    /^\d+\.\d+\.\d+/,
    "native SQLite identity",
  );

  const assertions = byKind("assertion"),
    wanted = document.assertions;
  assert.equal(
    assertions.length,
    expected.assertions,
    "complete Order assertion count",
  );
  assert.deepEqual(
    assertions.map(({ time, data }) => [
      time,
      data.assertionId,
      data.assertionKind,
    ]),
    wanted.map((item) => [item.atMs, item.id, item.kind]),
    "all authored Order assertions",
  );
  assertions.forEach((event, index) => {
    const assertion = wanted[index];
    assert.equal(event.data.passed, true, "Order assertion did not pass");
    assert.equal(
      encodeJson(event.data.expected),
      canonical(assertion.expected),
      "authored complete Order expectation",
    );
    assert.equal(
      encodeJson(event.data.actual),
      canonical(assertion.expected),
      "independent complete Order actual",
    );
    assert.equal(
      event.actor,
      "actor" in assertion ? assertion.actor : "@runtime",
      "Order assertion actor",
    );
  });

  const receipts = byKind("receipt"),
    controls = byKind("control-receipt");
  const delivered = byKind("delivered").filter(
    (event) => event.data.channel === "client-frame",
  );
  assert.equal(
    receipts.length,
    expected.receipts,
    "complete publication receipt count",
  );
  assert.equal(
    controls.length,
    expected.controls,
    "complete control receipt count",
  );
  assert.equal(
    delivered.length,
    expected.frames,
    "complete client frame count",
  );
  // Final cumulative observations are independent authored arrays, including each
  // client separately; recovery's lost control replies are checked below at emission.
  for (const kind of ["source-receipts", "client-frames"] as const) {
    const finals = new Map<string, unknown>();
    for (const assertion of wanted)
      if (assertion.kind === kind && "actor" in assertion)
        finals.set(assertion.actor, assertion.expected);
    for (const [actor, values] of finals) {
      const events = (kind === "source-receipts" ? receipts : delivered).filter(
        (event) => event.actor === actor,
      );
      assert.equal(
        encodeJson(events.map((event) => event.data.envelope)),
        canonical(values),
        `complete authored ${kind} for ${actor}`,
      );
    }
  }
  const expectedControls =
    expected.group === "ordinary"
      ? ordinaryControls()
      : expected.group === "retention"
        ? retentionControls(document.untilMs)
        : expected.group === "after"
          ? [watermark("A"), watermark("A", true), watermark("B")]
          : [watermark("A")];
  assert.equal(
    encodeJson(controls.map((event) => event.data.envelope)),
    canonical(expectedControls),
    "complete authored watermark emissions",
  );

  const initialized = byKind("runtime-initialized");
  assert.deepEqual(
    initialized.map((event) => [
      event.generation,
      event.time,
      integer(event.data.wallMillis, "wall"),
      integer(event.data.monotonicMs, "monotonic"),
    ]),
    expected.generations.map(({ start }, i) => [
      i + 1,
      start,
      document.clock.epochMillis + start,
      0,
    ]),
    "independent Order generation clocks",
  );
  if (expected.group !== "ordinary") {
    const snapshots =
      expected.group === "retention"
        ? ["order-summary", "order-tracking"].map((view) =>
            retentionSnapshot(
              "confirmed",
              view as "order-summary" | "order-tracking",
            ),
          )
        : recoverySnapshots(expected.group as Variant);
    assert.equal(
      encodeJson(initialized[1].data.snapshots),
      canonical(snapshots),
      "independent installed Order recovery",
    );
  }
  assert.deepEqual(
    byKind("action")
      .filter((event) => event.data.actionKind === "service-stop")
      .map((event) => [event.time, event.generation, event.data.mode]),
    expected.group === "ordinary"
      ? []
      : expected.group === "retention"
        ? [[50, 1, "abrupt"]]
        : [[48, 1, variants[expected.group].mode]],
    "authored Order stop boundary",
  );
  const end = JSON.parse(parsed.lines.at(-1)!);
  assert.deepEqual(
    [end.pendingFutureTasks, end.pendingMessages, end.heldFrames],
    [expected.group === "retention" ? 0 : 1, 0, 0],
    "exact Order end conditions",
  );
  assert.deepEqual(
    byKind("fault-decision"),
    [],
    "Order campaign has no invented seed/fault coverage",
  );
  checkTiming(run, mode, expected);
  return run;
}

function checkTiming(
  run: DocumentRun,
  mode: CampaignMode,
  expected: OrderCounts,
) {
  const { hostDelayMs, paced, idlePauseMs, generations } = run.diagnostics;
  assert.deepEqual(
    [hostDelayMs, paced, idlePauseMs],
    [mode.hostDelay, mode.paced, mode.idlePauseMs],
    "requested Node timing mode",
  );
  assert.deepEqual(
    generations?.map((item) => item.runtimeGeneration),
    expected.generations.map((_, i) => i + 1),
    "complete timing generations",
  );
  let turn = 0;
  for (const [index, generation] of generations!.entries()) {
    const wanted = expected.generations[index];
    assert.equal(
      generation.jvm?.pauseMillis,
      mode.jvmPauseMs,
      "requested JVM timing mode",
    );
    assert.deepEqual(
      generation.jvm?.pauses
        .map((pause) => [pause.site, pause.virtualMs])
        .sort(),
      mode.jvmPauseMs
        ? [
            ...(wanted.alarm === undefined
              ? []
              : [["alarm-dispatch", wanted.alarm]]),
            ["state-effect", wanted.state],
            ["writer-handoff", wanted.writer],
          ]
        : [],
      "actual JVM state and writer pauses",
    );
    for (const pause of generation.jvm!.pauses) {
      assert.equal(pause.requestedMillis, mode.jvmPauseMs);
      assert.ok(
        Number.isSafeInteger(pause.elapsedNanos) &&
          pause.elapsedNanos >= mode.jvmPauseMs * 1_000_000,
        "measured JVM pause too short",
      );
    }
    assert.equal(
      generation.node.length,
      mode.hostDelay ? wanted.commands : 0,
      "complete Node command pauses",
    );
    for (const pause of generation.node) {
      assert.equal(
        pause.turn,
        turn++,
        "continuous command identities across fresh JVMs",
      );
      assert.equal(pause.requestedMillis, mode.hostDelay);
      assert.ok(
        Number.isSafeInteger(pause.elapsedNanos) &&
          pause.elapsedNanos > 50_000_000,
        "measured Node pause too short",
      );
    }
    if (mode.hostDelay) {
      assert.deepEqual(
        [generation.node[0].operation, generation.node[0].timeMs],
        ["initialize-document", wanted.start],
        "actual generation initialization pause",
      );
      for (const operation of ["ingress", "observe-installed", "task"])
        assert.ok(
          generation.node.some((pause) => pause.operation === operation),
          `missing Node ${operation} pause`,
        );
      if (
        index === 0 ||
        expected.group === "after" ||
        expected.group === "retention"
      )
        assert.ok(
          generation.node.some((pause) => pause.operation === "progress"),
          "missing Node progress pause",
        );
    }
  }
}
