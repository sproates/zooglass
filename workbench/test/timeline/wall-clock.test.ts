import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { RuntimeGenerations } from "../../src/timeline/runtime-generations.js";
import { fixture } from "./document-fixture.js";
import { Bridge } from "../../src/timeline/bridge.js";
import { runDocument } from "../../src/timeline/run-document.js";
import {
  replayDocument,
  parseReplay,
} from "../../src/timeline/replay-document.js";
import { canonicalJson } from "../../src/timeline/json.js";
import {
  installed,
  sqliteFiles,
  sqliteInput,
  target,
} from "./sqlite-document-fixture.js";
import { epoch, source } from "./document-fixture.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
function snapshot(
  version: number,
  freshness: string,
  received: number | null,
  entityId = "sku-4",
  amount = 1,
  sequence = 1,
) {
  const value = structuredClone(installed(version, freshness));
  value.entityId = entityId;
  value.data = {
    reading: { publicationSequence: sequence, payload: { amount } },
  };
  value.provenance.reading!.sourceEntityId = entityId;
  value.status.inputs["warehouse-feed"].sourceEntityId = entityId;
  value.status.fields.reading.receivedAtMillis = received;
  return value;
}
const observe = (
  id: string,
  atMs: number,
  expected: unknown,
  entityId = "sku-4",
) => ({
  id,
  atMs,
  kind: "runtime-snapshot",
  viewId: "stock-view",
  entityId,
  expected: { outcome: "available", snapshot: expected },
});
const connect = (atMs: number, id = "connect") => ({
  id,
  atMs,
  kind: "connect",
  actor: source,
});
const send = (
  atMs: number,
  publication = "report-1",
  id = "send",
  kind = "source-send",
) => ({ id, atMs, kind, actor: source, publication });
const wall = (atMs: number, wallMillis: number) => ({
  id: "wall",
  atMs,
  kind: "wall-clock-set",
  wallMillis,
});
const stop = (atMs: number) => ({
  id: "stop",
  atMs,
  kind: "service-stop",
  mode: "abrupt",
});
const start = (atMs: number) => ({ id: "start", atMs, kind: "service-start" });
function setup() {
  const input = sqliteInput();
  input.configuration.views[0].fields.reading.freshness.staleAfterMillis = 50;
  input.document.id = "wall-clock-case";
  return input;
}
async function execute(input: ReturnType<typeof setup>, paused = false) {
  const files = await sqliteFiles(input);
  try {
    const result = await runDocument(files.path, {
      jar,
      hostDelay: paused ? 70 : 0,
      jvmPauseMs: paused ? 90 : 0,
    });
    assert.equal(
      result.outcome,
      "passed",
      result.message ?? "unexpected outcome",
    );
    parseReplay(JSON.stringify(result));
    return result;
  } finally {
    await files.close();
  }
}

test("a live forward wall jump does not replace monotonic expiry or emit state changes", async () => {
  const input = setup();
  input.document.actions = [connect(0), send(10), wall(20, epoch + 1000)];
  input.document.assertions = [
    observe("still-fresh", 20, snapshot(1, "fresh", epoch + 10)),
    observe("before", 59, snapshot(1, "fresh", epoch + 10)),
    observe("expired", 60, snapshot(2, "stale", epoch + 10)),
  ];
  input.document.untilMs = 60;
  const result = await execute(input);
  const events = result.trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.filter((e) => e.kind === "state").map((e) => e.key[0]),
    [10, 60],
  );
});

test("downtime rollback produces unknown age; duplicate retains it and new input repairs it", async () => {
  const input = setup();
  input.document.actions = [
    connect(0),
    send(10),
    stop(11),
    wall(20, epoch + 5),
    start(21),
    connect(22, "reconnect"),
    send(22, "report-1", "retry", "source-retry"),
    send(30, "report-2", "repair"),
  ];
  input.document.assertions = [
    observe("recovered", 21, snapshot(2, "ageUnknown", null)),
    observe("duplicate-keeps-unknown", 22, snapshot(2, "ageUnknown", null)),
    observe("repaired", 30, snapshot(3, "fresh", epoch + 15, "sku-4", 2, 2)),
    observe("still-fresh", 79, snapshot(3, "fresh", epoch + 15, "sku-4", 2, 2)),
    observe("expired", 80, snapshot(4, "stale", epoch + 15, "sku-4", 2, 2)),
  ];
  input.document.untilMs = 80;
  const baseline = await execute(input);
  assert.equal((await execute(input, true)).trace, baseline.trace);
  const directory = await mkdtemp(join(tmpdir(), "wall-replay-"));
  try {
    const path = join(directory, "run.json");
    await writeFile(path, JSON.stringify(baseline));
    assert.equal((await replayDocument(path, { jar })).status, "verified");
    const records = baseline.trace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    records.find(
      (e) => e.kind === "action" && e.data.actionKind === "wall-clock-set",
    ).data.wallMillis++;
    assert.throws(
      () =>
        parseReplay(
          JSON.stringify({
            ...baseline,
            trace:
              records.map((e) => canonicalJson(JSON.stringify(e))).join("\n") +
              "\n",
          }),
        ),
      /wall|clock|action|initial/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live rollback followed only by a duplicate does not manufacture durable uncertainty", async () => {
  const input = setup();
  input.document.actions = [
    connect(0),
    send(10),
    wall(20, epoch + 5),
    send(21, "report-1", "retry", "source-retry"),
    stop(22),
    start(50),
  ];
  input.document.assertions = [
    observe("live-fresh", 21, snapshot(1, "fresh", epoch + 10)),
    observe("recovered-fresh", 50, snapshot(1, "fresh", epoch + 10)),
    observe("before", 74, snapshot(1, "fresh", epoch + 10)),
    observe("expired", 75, snapshot(2, "stale", epoch + 10)),
  ];
  input.document.untilMs = 75;
  await execute(input);
});

test("a new commit persists rollback uncertainty even after wall time catches up", async () => {
  const input = setup();
  input.document.observationTargets = [
    target,
    { ...target, entityId: "sku-5" },
  ];
  const publications = input.document.publications as {
    id: string;
    body: Record<string, unknown>;
  }[];
  publications.push({
    id: "entity-b",
    body: {
      sourceId: "warehouse-feed",
      epoch: "day-1",
      sourceEntityId: "sku-5",
      publicationSequence: 1,
      type: "stock",
      payload: { amount: 2 },
    },
  });
  input.document.actions = [
    connect(0),
    send(10),
    wall(20, epoch + 5),
    send(21, "entity-b", "commit-b"),
    stop(22),
    start(50),
  ];
  input.document.assertions = [
    observe("a-uncertain", 50, snapshot(3, "ageUnknown", null)),
    observe(
      "b-fresh",
      50,
      snapshot(2, "fresh", epoch + 6, "sku-5", 2),
      "sku-5",
    ),
    observe(
      "b-expired",
      71,
      snapshot(4, "stale", epoch + 6, "sku-5", 2),
      "sku-5",
    ),
  ];
  input.document.untilMs = 71;
  await execute(input);
});

for (const before of [true, false]) {
  test(`same-time wall adjustment ${before ? "before" : "after"} startup affects only subsequent recovery`, async () => {
    const input = setup();
    input.document.actions = [
      connect(0),
      send(10),
      stop(11),
      ...(before
        ? [wall(21, epoch + 6), start(21)]
        : [start(21), wall(21, epoch + 6)]),
    ];
    input.document.assertions = [
      observe(
        "recovered",
        21,
        snapshot(
          before ? 2 : 1,
          before ? "ageUnknown" : "fresh",
          before ? null : epoch + 10,
        ),
      ),
    ];
    input.document.untilMs = 21;
    input.document.end = {
      pendingFutureTasks: "allow",
      pendingMessages: 0,
      heldFrames: 0,
    };
    await execute(input);
  });
}

test("older hosts reject wall adjustments before SQLite allocation", async () => {
  const input = setup();
  input.document.actions = [wall(10, epoch)];
  input.document.assertions = [];
  input.document.untilMs = 10;
  const files = await sqliteFiles(input);
  const parent = await mkdtemp(join(tmpdir(), "wall-capability-"));
  const open = Bridge.open;
  Bridge.open = async (...args) => {
    const opened = await open(...args);
    opened.bridge.wallClockAdjustments = 0;
    return opened;
  };
  try {
    await assert.rejects(
      runDocument(files.path, { jar, diagnosticDirectory: parent }),
      /wall clock/,
    );
    assert.deepEqual(await readdir(parent), []);
  } finally {
    Bridge.open = open;
    await files.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("invalid clock-only acknowledgment poisons its owner without trusting caller-mutated counts", async () => {
  const owner = new RuntimeGenerations({
    jar,
    configuration: JSON.stringify(fixture().configuration),
    epochMillis: epoch,
    commandLimit: 20,
  });
  const command = Bridge.prototype.command;
  try {
    const initialized = await owner.start(0);
    initialized.pendingTasks = 1; // A caller must not alter the owner's accounting.
    Bridge.prototype.command = async function (time, operation) {
      const response = await command.call(this, time, operation);
      if (operation.op === "wall-clock-set") response.pendingTasks = 1;
      return response;
    };
    await assert.rejects(owner.setWall(10, epoch), /changed runtime work/);
    assert.equal(owner.current, undefined);
    await assert.rejects(owner.start(10), /changed runtime work/);
  } finally {
    Bridge.prototype.command = command;
    await owner.close();
  }
});
