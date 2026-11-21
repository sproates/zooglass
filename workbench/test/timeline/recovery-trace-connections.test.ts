import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encodeJson, parseJson } from "../../src/timeline/json.js";
import { parseReplay } from "../../src/timeline/replay-document.js";
import { runDocument } from "../../src/timeline/run-document.js";
import { TraceProjections } from "../../src/timeline/trace-projections.js";
import type { TraceEvent } from "../../src/timeline/trace-generations.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);

test("V4 permits one explicit cleanup of a runtime-closed connection", () => {
  const trace = new TraceProjections(true);
  const event = (kind: string, actionKind?: string): TraceEvent => ({
    kind,
    id: "event",
    parent: null,
    causes: [],
    actor: "viewer",
    timeMs: 1,
    key: [1, 0, 0, 0],
    runtimeGeneration: 1,
    connectionGeneration: 1,
    data: actionKind ? { actionKind } : {},
  });
  trace.accept(event("action", "connect"), "trace");
  // Delivery overflow can close the socket before the declared cleanup action.
  trace.accept(event("connection-closed"), "trace");
  trace.accept(event("action", "disconnect"), "trace");
  assert.throws(
    () => trace.accept(event("action", "disconnect"), "trace"),
    /attached connection/,
  );
  // Host close callbacks are separate from the declaration that removed a session.
  assert.doesNotThrow(() => trace.accept(event("connection-closed"), "trace"));
  assert.doesNotThrow(() =>
    trace.accept(
      { ...event("action", "connect"), connectionGeneration: 2 },
      "trace",
    ),
  );
});

test("V4 rejects traffic from a closed source connection within the same runtime generation", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "recovery-connections-"));
  try {
    const fixture = resolve("scenarios/timeline-static-recovery/m1");
    const scenario = JSON.parse(
      await readFile(join(fixture, "scenario.json"), "utf8"),
    );
    // Reconnecting before the first publication changes connection ownership,
    // but leaves every independently authored data/receipt expectation intact.
    scenario.actions.push(
      {
        id: "disconnect-in-generation",
        kind: "disconnect",
        actor: "kiln-source",
        atMs: 3,
      },
      {
        id: "reconnect-in-generation",
        kind: "connect",
        actor: "kiln-source",
        atMs: 4,
      },
    );
    await writeFile(
      join(directory, "runtime.json"),
      await readFile(join(fixture, "runtime.json")),
    );
    const path = join(directory, "scenario.json");
    await writeFile(path, JSON.stringify(scenario));
    const run = await runDocument(path, {
      jar,
      diagnosticDirectory: directory,
    });
    assert.equal(
      run.outcome,
      "passed",
      run.message ?? "expected passing fixture",
    );
    assert.doesNotThrow(() => parseReplay(JSON.stringify(run)));

    for (const kind of ["action", "receipt", "delivered"]) {
      await context.test(`rejects the retired connection on ${kind}`, () => {
        const records = run.trace
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line));
        const record = records.find(
          (entry) =>
            entry.kind === kind &&
            entry.actor === "kiln-source" &&
            entry.runtimeGeneration === 1 &&
            entry.connectionGeneration === 2 &&
            (kind !== "action" || entry.data.actionKind === "source-send"),
        );
        assert.ok(record, `fixture must exercise ${kind}`);
        record.connectionGeneration = 1;
        const trace = records
          .map((entry) => encodeJson(parseJson(JSON.stringify(entry))) + "\n")
          .join("");
        assert.throws(
          () => parseReplay(JSON.stringify({ ...run, trace })),
          /active connection/,
        );
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
