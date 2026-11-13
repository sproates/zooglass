import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  fixture,
  files,
  ack,
  frame,
  receipt,
  epoch,
  source,
  client,
  action,
} from "./document-fixture.js";
import { runDocument } from "../../src/timeline/run-document.js";
import { replayDocument } from "../../src/timeline/replay-document.js";
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
const records = (trace: string) =>
  trace
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
function delayed(sourceLatency = 3, clientLatency = 4) {
  const f = fixture();
  f.document.actions = f.document.actions.slice(0, 4);
  f.document.links.find((l) => l.actor === source)!.latencyMs = sourceLatency;
  f.document.links.find((l) => l.actor === client)!.latencyMs = clientLatency;
  f.document.untilMs = 10 + sourceLatency + 50 + clientLatency;
  f.document.assertions = [
    {
      id: "receipts",
      kind: "source-receipts",
      actor: source,
      atMs: f.document.untilMs,
      expected: [receipt(1, 1)],
    },
    {
      id: "frames",
      kind: "client-frames",
      actor: client,
      atMs: f.document.untilMs,
      expected: [
        ack,
        frame(),
        frame(1, 1, "fresh", epoch + 10 + sourceLatency),
        frame(2, 1, "stale", epoch + 10 + sourceLatency),
      ],
    },
  ];
  return f;
}

test("positive links delay real ingress, receipts, subscription and frame arrival with exact freshness and replay", async () => {
  const f = delayed();
  f.document.assertions.push(
    {
      id: "not-yet-subscribed",
      kind: "client-frames",
      actor: client,
      atMs: 7,
      expected: [],
    },
    {
      id: "baseline",
      kind: "client-frames",
      actor: client,
      atMs: 8,
      expected: [ack, frame()],
    },
    {
      id: "no-receipt-yet",
      kind: "source-receipts",
      actor: source,
      atMs: 15,
      expected: [],
    },
    {
      id: "fresh-frame-not-yet",
      kind: "client-frames",
      actor: client,
      atMs: 16,
      expected: [ack, frame()],
    },
  );
  const input = await files(f, (wire) =>
    wire.replaceAll('"amount":1}', '"amount":9007199254740993}'),
  );
  try {
    const run = await runDocument(input.path, { jar });
    assert.equal(run.outcome, "passed", run.message);
    assert.ok(run.trace.includes("9007199254740993"));
    const trace = records(run.trace);
    assert.equal(trace.find((e) => e.kind === "state").key[0], 13);
    assert.equal(
      trace.find(
        (e) => e.kind === "delivered" && e.data.channel === "source-receipt",
      ).key[0],
      16,
    );
    const saved = input.path + ".run.json";
    await writeFile(saved, JSON.stringify(run));
    const replay = await replayDocument(saved, {
      jar,
      hostDelay: 1,
      paced: true,
      idlePauseMs: 60,
    });
    assert.equal(replay.status, "verified");
    assert.equal(replay.actual.trace, run.trace);
  } finally {
    await input.close();
  }
});

test("same-time source burst preserves directional FIFO and complete view versions", async () => {
  const f = delayed();
  f.document.actions.push(
    action("send-2", 10, "source-send", source, { publication: "report-2" }),
  );
  f.document.assertions[0].expected = [receipt(1, 1), receipt(2, 2)];
  f.document.assertions[1].expected = [
    ack,
    frame(),
    frame(1, 1, "fresh", epoch + 13),
    frame(2, 2, "fresh", epoch + 13),
    frame(3, 2, "stale", epoch + 13),
  ];
  const input = await files(f);
  try {
    const run = await runDocument(input.path, { jar });
    assert.equal(run.outcome, "passed", run.message);
    const incoming = records(run.trace).filter(
      (e) => e.kind === "delivered" && e.data.channel === "source-publication",
    );
    assert.deepEqual(
      incoming.map((e) => e.data.envelope.publicationSequence),
      [1, 2],
    );
    assert.deepEqual(
      incoming.map((e) => e.key[0]),
      [13, 13],
    );
  } finally {
    await input.close();
  }
});

test("disconnect before ingress immediately drops the queued publication and permits a clean early end", async () => {
  const f = delayed();
  f.document.actions.push(action("close-source", 12, "disconnect", source));
  f.document.untilMs = 12;
  f.document.assertions = [
    {
      id: "no-receipt",
      kind: "source-receipts",
      actor: source,
      atMs: 12,
      expected: [],
    },
    {
      id: "no-commit",
      kind: "client-frames",
      actor: client,
      atMs: 12,
      expected: [ack, frame()],
    },
  ];
  const input = await files(f);
  try {
    const run = await runDocument(input.path, { jar });
    assert.equal(run.outcome, "passed", run.message);
    const trace = records(run.trace);
    assert.ok(!trace.some((e) => e.kind === "state"));
    const drop = trace.find(
      (e) => e.kind === "dropped" && e.data.channel === "source-publication",
    );
    assert.equal(drop.key[0], 12);
    assert.equal(
      trace.find((e) => e.eventId === drop.parentId).kind,
      "connection-closed",
    );
    assert.equal(trace.at(-1).pendingMessages, 0);
  } finally {
    await input.close();
  }
});

test("close after commit loses return without undoing state; explicit reconnect retry is a duplicate", async () => {
  const f = delayed();
  f.document.actions.push(
    action("close-source", 14, "disconnect", source),
    action("reopen-source", 15, "connect", source),
    action("retry", 16, "source-retry", source, { publication: "report-1" }),
  );
  f.document.assertions[0].expected = [receipt(1, 1, true)];
  const input = await files(f);
  try {
    const run = await runDocument(input.path, { jar });
    assert.equal(run.outcome, "passed", run.message);
    const trace = records(run.trace);
    const drop = trace.find(
      (e) => e.kind === "dropped" && e.data.channel === "source-receipt",
    );
    assert.equal(drop.key[0], 14);
    const delivery = trace.find(
      (e) => e.kind === "delivered" && e.data.channel === "source-receipt",
    );
    assert.equal(delivery.connectionGeneration, 2);
    assert.equal(delivery.key[0], 22);
  } finally {
    await input.close();
  }
});

test("client closure cancels old requests and buffered frames without affecting replacement subscription", async () => {
  const f = delayed();
  f.document.actions.push(
    action("unsubscribe-old", 5, "client-unsubscribe", client, {
      viewId: "stock-view",
      entityId: "sku-4",
    }),
    action("close-client", 6, "disconnect", client),
    action("open-client", 7, "connect", client),
    action("subscribe-new", 7, "client-subscribe", client, {
      viewId: "stock-view",
      entityId: "sku-4",
    }),
  );
  f.document.assertions.push({
    id: "nothing-old",
    kind: "client-frames",
    actor: client,
    atMs: 14,
    expected: [],
  });
  const input = await files(f);
  try {
    const run = await runDocument(input.path, { jar });
    assert.equal(run.outcome, "passed", run.message);
    const trace = records(run.trace);
    const drops = trace.filter(
      (e) => e.kind === "dropped" && e.actor === client,
    );
    assert.deepEqual(
      drops.map((e) => e.data.channel),
      ["client-frame", "client-frame", "client-request"],
    );
    assert.ok(
      drops.every((e) => e.key[0] === 6 && e.connectionGeneration === 1),
    );
    assert.ok(
      trace
        .filter(
          (e) =>
            e.kind === "delivered" &&
            e.actor === client &&
            e.data.channel === "client-frame",
        )
        .every((e) => e.connectionGeneration === 2),
    );
  } finally {
    await input.close();
  }
});

function managed(
  latency: number,
  timeout: number,
  interval = 0,
  maxAttempts = 2,
) {
  const f = delayed(latency, 0);
  return {
    configuration: f.configuration,
    document: {
      ...f.document,
      assertions: [],
      retries: [
        {
          action: "send-1",
          maxAttempts,
          receiptTimeoutMs: timeout,
          retryIntervalMs: interval,
        },
      ],
    },
  };
}
test("timeouts shorter than outbound delay prevent ingress; between ingress and return retries remain duplicates", async () => {
  for (const timeout of [3, 6]) {
    const input = await files(managed(4, timeout));
    try {
      const run = await runDocument(input.path, { jar });
      assert.equal(run.outcome, "assertion-failed", run.message);
      assert.match(run.message!, /attempts exhausted/);
      const trace = records(run.trace);
      const receipts = trace.filter((e) => e.kind === "receipt");
      assert.deepEqual(
        receipts.map((e) => e.data.envelope.status),
        timeout === 3 ? [] : ["applied", "duplicate"],
      );
      assert.equal(
        trace.filter((e) => e.kind === "state").length,
        timeout === 3 ? 0 : 1,
      );
      assert.ok(
        !trace.some(
          (e) => e.kind === "retry-status" && e.data.status === "acknowledged",
        ),
      );
      const saved = input.path + ".run.json";
      await writeFile(saved, JSON.stringify(run));
      assert.equal((await replayDocument(saved, { jar })).status, "verified");
    } finally {
      await input.close();
    }
  }
});

test("positive round-trip deadline ties and delayed receipt during retry wait follow cancellation contract", async () => {
  for (const [timeout, interval, attempts, pass] of [
    [8, 0, 2, true],
    [8, 0, 1, false],
    [6, 3, 2, true],
  ] as const) {
    const input = await files(managed(4, timeout, interval, attempts));
    try {
      const run = await runDocument(input.path, { jar });
      assert.equal(
        run.outcome,
        pass ? "passed" : "assertion-failed",
        run.message,
      );
      const trace = records(run.trace);
      assert.ok(!trace.some((e) => e.kind === "retry-attempt"));
      if (pass) {
        assert.equal(
          trace.find(
            (e) =>
              e.kind === "retry-status" && e.data.status === "acknowledged",
          ).key[0],
          18,
        );
        assert.ok(
          trace.some(
            (e) => e.kind === "cancelled" && e.data.taskId.startsWith("-"),
          ),
        );
      } else
        assert.equal(
          trace.find(
            (e) => e.kind === "retry-status" && e.data.status === "exhausted",
          ).key[0],
          18,
        );
    } finally {
      await input.close();
    }
  }
});

test("pending delayed messages cannot pass the horizon or bypass message budgets", async () => {
  for (const limited of [false, true]) {
    const f = delayed();
    f.document.assertions = [];
    if (limited) f.document.limits.pendingMessages = 1;
    else {
      f.document.untilMs = 11;
      f.document.end.pendingFutureTasks = "allow";
    }
    const input = await files(f);
    try {
      const run = await runDocument(input.path, { jar });
      assert.equal(
        run.outcome,
        limited ? "limit-exceeded" : "assertion-failed",
        run.message,
      );
      assert.ok(records(run.trace).at(-1).pendingMessages > 0);
    } finally {
      await input.close();
    }
  }
});
