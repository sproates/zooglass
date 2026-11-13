import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { runDocument } from "../../src/timeline/run-document.js";
import { validateTrace } from "../../src/timeline/trace-contract.js";
import {
  fixture,
  files,
  action,
  source,
  client,
  frame,
  ack,
  epoch,
} from "./document-fixture.js";
const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ?? "../zooglass/target/zooglass.jar",
);
const events = (trace: string) =>
  trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

test("document executes real configured runtime with independent receipts/frames, retry, epoch and exact data", async () => {
  const input = await files(fixture(), (wire) =>
    wire.replaceAll('"amount":1}', '"amount":9007199254740993}'),
  );
  try {
    const result = await runDocument(input.path, { jar });
    assert.equal(result.outcome, "passed", result.message);
    assert.equal(validateTrace(result.trace), result.trace);
    assert.ok(result.trace.includes("9007199254740993"));
    const trace = events(result.trace);
    assert.ok(
      trace.some(
        (e) =>
          e.kind === "action" &&
          e.actor === source &&
          e.connectionGeneration === 2,
      ),
    );
    const expiry = trace.find(
      (e) => e.kind === "state" && e.data.envelope.version === 2,
    );
    const task = trace.find((e) => e.eventId === expiry.parentId);
    assert.equal(task.kind, "task-dispatched");
    assert.equal(
      trace.find((e) => e.eventId === task.parentId).kind,
      "scheduled",
    );
    assert.ok(trace.some((e) => e.kind === "frame" && e.causes?.length === 1));
  } finally {
    await input.close();
  }
});

test("fresh document runs retain identical semantic traces despite bridge delays, host pauses and pacing", async () => {
  const input = await files();
  try {
    const baseline = await runDocument(input.path, { jar });
    assert.equal(baseline.outcome, "passed", baseline.message);
    for (const hostDelay of [1, 2]) {
      const other = await runDocument(input.path, {
        jar,
        hostDelay,
        paced: true,
        idlePauseMs: 70,
      });
      assert.equal(other.outcome, "passed", other.message);
      assert.equal(other.trace, baseline.trace);
    }
  } finally {
    await input.close();
  }
});

test("wrong independent expectation produces a completed failure prefix, never a passing result", async () => {
  const f = fixture();
  f.document.assertions[0].expected = [];
  const input = await files(f);
  try {
    const result = await runDocument(input.path, { jar });
    assert.equal(result.outcome, "assertion-failed");
    assert.equal(result.message, "assertion-failed: initial");
    const trace = events(validateTrace(result.trace));
    assert.equal(trace.at(-1).outcome, "assertion-failed");
    assert.ok(
      !trace.some((e) => e.kind === "action" && e.data.actionId === "send-1"),
    );
  } finally {
    await input.close();
  }
});

test("future-task end policy is checked before shutdown cancellation", async () => {
  const f = fixture();
  f.document.actions = f.document.actions.slice(0, 4);
  f.document.assertions = [];
  f.document.untilMs = 20;
  const input = await files(f);
  try {
    const result = await runDocument(input.path, { jar });
    assert.equal(result.outcome, "assertion-failed");
    assert.equal(events(result.trace).at(-1).pendingFutureTasks, 1);
  } finally {
    await input.close();
  }
  f.document.end.pendingFutureTasks = "allow";
  const allowed = await files(f);
  try {
    const result = await runDocument(allowed.path, { jar });
    assert.equal(result.outcome, "passed", result.message);
    const trace = events(result.trace);
    assert.equal(trace.at(-1).pendingFutureTasks, 1);
    assert.ok(
      trace.some((e) => e.kind === "cancelled" && e.causes.length === 1),
    );
  } finally {
    await allowed.close();
  }
});

test("document and runtime profiles reject unsupported capabilities without fallback", async () => {
  const f = fixture();
  f.configuration.views[0].fields.reading.mode = "latestBySequence";
  const input = await files(f);
  try {
    await assert.rejects(
      runDocument(input.path, { jar }),
      /outside memory-arrival-v1/,
    );
  } finally {
    await input.close();
  }
  const excessive = fixture();
  excessive.document.limits.turns = 2001;
  const other = await files(excessive);
  try {
    await assert.rejects(
      runDocument(other.path, { jar: "/no-artifact.jar" }),
      /expected integer/,
    );
  } finally {
    await other.close();
  }
});

test("coalescing and stalled writer use real queue behaviour without blocking a healthy client", async () => {
  const f = fixture();
  f.configuration.delivery.slowClient = "coalesceLatestState";
  f.configuration.delivery.maxQueuedMessages = 3;
  const healthy = "healthy";
  f.document.actors.push({ id: healthy, role: "client" });
  f.document.links.push({ actor: healthy, latencyMs: 0 });
  f.document.actions = [
    action("cs", 0, "connect", source),
    action("cc", 0, "connect", client),
    action("stall", 0, "writer-stall", client),
    action("ch", 0, "connect", healthy),
    action("subc", 0, "client-subscribe", client, {
      viewId: "stock-view",
      entityId: "sku-4",
    }),
    action("subh", 0, "client-subscribe", healthy, {
      viewId: "stock-view",
      entityId: "sku-4",
    }),
    action("p1", 10, "source-send", source, { publication: "report-1" }),
    ...[2, 3, 4].map((s) =>
      action(`p${s}`, 20, "source-send", source, {
        publication: `report-${s}`,
      }),
    ),
    action("release", 40, "writer-release", client, { fail: false }),
  ];
  f.document.untilMs = 70;
  f.document.assertions = [
    {
      id: "healthy",
      atMs: 20,
      kind: "client-frames",
      actor: healthy,
      expected: [
        ack,
        frame(),
        frame(1, 1, "fresh", epoch + 10),
        frame(4, 4, "fresh", epoch + 20),
      ],
    },
    {
      id: "held",
      atMs: 20,
      kind: "client-frames",
      actor: client,
      expected: [],
    },
    {
      id: "released",
      atMs: 70,
      kind: "client-frames",
      actor: client,
      expected: [
        ack,
        frame(),
        frame(4, 4, "fresh", epoch + 20),
        frame(5, 4, "stale", epoch + 20),
      ],
    },
  ];
  const input = await files(f);
  try {
    const result = await runDocument(input.path, { jar });
    assert.equal(result.outcome, "passed", result.message);
  } finally {
    await input.close();
  }
});

test("client disconnect discards held delivery and reconnect starts a fresh generation", async () => {
  for (const failedRelease of [false, true]) {
    const f = fixture();
    f.document.actions = [
      action("cs", 0, "connect", source),
      action("cc", 0, "connect", client),
      action("stall", 0, "writer-stall", client),
      action("sub", 0, "client-subscribe", client, {
        viewId: "stock-view",
        entityId: "sku-4",
      }),
      ...(failedRelease
        ? [action("fail", 4, "writer-release", client, { fail: true })]
        : []),
      action("disconnect", 5, "disconnect", client),
      action("reconnect", 6, "connect", client),
      action("resubscribe", 6, "client-subscribe", client, {
        viewId: "stock-view",
        entityId: "sku-4",
      }),
      action("send", 10, "source-send", source, { publication: "report-1" }),
    ];
    f.document.untilMs = 60;
    f.document.assertions = [
      {
        id: "nothing-old",
        atMs: 5,
        kind: "client-frames",
        actor: client,
        expected: [],
      },
      {
        id: "new-generation",
        atMs: 60,
        kind: "client-frames",
        actor: client,
        expected: [
          ack,
          frame(),
          frame(1, 1, "fresh", epoch + 10),
          frame(2, 1, "stale", epoch + 10),
        ],
      },
    ];
    const input = await files(f);
    try {
      const result = await runDocument(input.path, { jar });
      assert.equal(result.outcome, "passed", result.message);
      const trace = events(result.trace);
      assert.ok(
        trace.some((e) => e.kind === "dropped" && e.connectionGeneration === 1),
      );
      assert.ok(
        trace
          .filter((e) => e.kind === "delivered" && e.actor === client)
          .every((e) => e.connectionGeneration === 2),
      );
      const handoff = trace.find((e) => e.kind === "handoff");
      assert.equal(
        trace.find((e) => e.kind === "dropped").data.messageId,
        handoff.data.messageId,
      );
    } finally {
      await input.close();
    }
  }
});

test("disconnect-on-overflow closes only the stalled connection and preserves committed inputs", async () => {
  const f = fixture();
  f.configuration.delivery.maxQueuedMessages = 3;
  f.document.actions = [
    action("cs", 0, "connect", source),
    action("cc", 0, "connect", client),
    action("stall", 0, "writer-stall", client),
    action("sub", 0, "client-subscribe", client, {
      viewId: "stock-view",
      entityId: "sku-4",
    }),
    ...[1, 2, 3, 4].map((s) =>
      action(`send-${s}`, 10, "source-send", source, {
        publication: `report-${s}`,
      }),
    ),
  ];
  f.document.untilMs = 60;
  f.document.assertions = [
    {
      id: "nothing-delivered",
      atMs: 60,
      kind: "client-frames",
      actor: client,
      expected: [],
    },
  ];
  const input = await files(f);
  try {
    const result = await runDocument(input.path, { jar });
    assert.equal(result.outcome, "passed", result.message);
    const trace = events(result.trace);
    assert.ok(
      trace.some((e) => e.kind === "connection-closed" && e.actor === client),
    );
    assert.equal(
      trace.filter(
        (e) => e.kind === "receipt" && e.data.envelope.status === "applied",
      ).length,
      4,
    );
    assert.equal(trace.at(-1).heldFrames, 0);
  } finally {
    await input.close();
  }
});

test("runtime budgets produce deterministic failure prefixes with reserved final results", async () => {
  for (const [name, value] of [
    ["turns", 2],
    ["traceBytes", 1024],
    ["rounds", 1],
    ["queuedEvents", 2],
    ["pendingMessages", 1],
  ] as const) {
    const f = fixture();
    f.document.limits[name] = value;
    const input = await files(f);
    try {
      const result = await runDocument(input.path, { jar });
      assert.equal(
        result.outcome,
        "limit-exceeded",
        `${name}: ${result.message}`,
      );
      assert.equal(validateTrace(result.trace), result.trace);
      assert.ok(
        Buffer.byteLength(result.trace) <= f.document.limits.traceBytes,
      );
    } finally {
      await input.close();
    }
  }
});

test("deep admitted payload preserves an incomplete artifact when trace wrapping exceeds structural bounds", async () => {
  const f = fixture();
  let value: unknown = 1;
  for (let i = 0; i < 59; i++) value = [value];
  (f.document.publications[0].body.payload as { amount: unknown }).amount =
    value;
  f.document.actions = f.document.actions.slice(0, 4);
  f.document.assertions = [];
  f.document.untilMs = 60;
  const input = await files(f);
  try {
    const result = await runDocument(input.path, { jar });
    assert.equal(result.outcome, "infrastructure-failed");
    assert.match(result.message!, /nesting limit/);
    const prefix = events(result.trace);
    assert.ok(
      prefix.some((e) => e.kind === "action" && e.data.actionId === "send-1"),
    );
    assert.ok(!prefix.some((e) => e.kind === "result"));
  } finally {
    await input.close();
  }
});

test("oversized initialization rejection leaves bridge clock and turn identity unchanged", async () => {
  const { Bridge } = await import("../../src/timeline/bridge.js");
  const { bridge } = await Bridge.open(jar);
  try {
    await assert.rejects(
      bridge.command(0, {
        op: "initialize-document",
        epochMillis: 123,
        wire: "x".repeat(16 * 1024 * 1024),
      }),
      /Command frame overflow/,
    );
    const response = await bridge.command(0, {
      op: "initialize",
      policy: "coalesceLatestState",
    });
    assert.equal(response.turnId, 0);
    assert.equal(response.timeMs, 0);
  } finally {
    await bridge.close();
  }
});
