import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  orderProfile,
  orderRestartProfile,
} from "../../src/timeline/evidence-versions.js";
import { encodeJson, parseJson } from "../../src/timeline/json.js";
import {
  parseReplay,
  replayDocument,
} from "../../src/timeline/replay-document.js";
import { runDocument } from "../../src/timeline/run-document.js";
import { parseTrace } from "../../src/timeline/trace-contract.js";
import { action } from "./document-fixture.js";
import {
  control,
  controlActor,
  controlAssertion,
  orderDocument,
  orderFiles,
  watermark,
} from "./order-document-fixture.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
const records = (trace: string) =>
  trace
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
const canonical = (value: unknown) =>
  encodeJson(parseJson(JSON.stringify(value)));

for (const mode of ["orderly", "abrupt"]) {
  for (const stopAt of [13, 16]) {
    test(`${mode} Order stop at ${stopAt} cancels the old control packet and preserves only committed progress`, async (t) => {
      const base = orderDocument(3);
      base.runtime.profile = orderRestartProfile;
      const input = await orderFiles(base);
      t.after(input.close);
      const committed = stopAt === 16;
      const doc = {
        ...base,
        untilMs: 30,
        actions: [
          ...base.actions,
          { id: "stop", atMs: stopAt, kind: "service-stop", mode },
          { id: "restart", atMs: 20, kind: "service-start" },
          action("reconnect", 21, "connect", controlActor),
          action("repeat", 22, "progress-send", controlActor, { control }),
        ],
        assertions: [
          controlAssertion("downtime", 18, []),
          controlAssertion("recovered", 30, [watermark(committed)]),
        ],
      };
      await writeFile(input.path, JSON.stringify(doc));
      const run = await runDocument(input.path, {
        jar,
        diagnosticDirectory: input.directory,
      });
      assert.equal(run.outcome, "passed", run.message);
      assert.equal(run.execution.profile, orderRestartProfile);
      const trace = records(run.trace);
      const initializations = trace.filter(
        (e) => e.kind === "runtime-initialized",
      );
      assert.deepEqual(
        initializations.map((e) => [
          e.runtimeGeneration,
          e.data.startTimeMs,
          e.data.monotonicMs,
        ]),
        [
          [1, 0, 0],
          [2, 20, 0],
        ],
      );
      const drop = trace.find(
        (e) => e.kind === "dropped" && e.data.channel.startsWith("progress-"),
      );
      assert.equal(
        drop.data.channel,
        committed ? "progress-receipt" : "progress-request",
      );
      assert.equal(drop.runtimeGeneration, 1);
      assert.equal(drop.connectionGeneration, 1);
      assert.equal(drop.key[0], stopAt);
      const cause = trace.find((e) => e.eventId === drop.parentId);
      // Progress sessions have no broadcaster writer to close in either stop mode.
      assert.equal(cause.kind, "action");
      assert.equal(cause.data.actionKind, "service-stop");
      const arrival = trace.find(
        (e) => e.kind === "delivered" && e.data.channel === "progress-receipt",
      );
      assert.equal(arrival.runtimeGeneration, 2);
      assert.equal(arrival.connectionGeneration, 2);
      assert.deepEqual(arrival.data.envelope, watermark(committed));
      assert.equal(trace.filter((e) => e.kind === "state").length, 2);
      assert.ok(
        trace
          .filter((e) => e.kind === "state")
          .every((e) => e.runtimeGeneration === (committed ? 1 : 2)),
      );
      assert.equal(trace.at(-1).pendingMessages, 0);

      const stale = records(run.trace);
      const receipt = stale.find(
        (e) => e.kind === "control-receipt" && e.runtimeGeneration === 2,
      );
      receipt.runtimeGeneration = 1;
      receipt.connectionGeneration = 1;
      assert.throws(
        () => parseTrace(stale.map(canonical).join("\n") + "\n"),
        /generation|connection/,
      );
      const relabeled = records(run.trace);
      relabeled[0].execution.profile = orderProfile;
      assert.throws(
        () => parseTrace(relabeled.map(canonical).join("\n") + "\n"),
        /does not support runtime lifecycle/,
      );
      const relabeledScenario = JSON.parse(run.scenario);
      relabeledScenario.runtime.profile = orderProfile;
      const scenario = canonical(relabeledScenario);
      relabeled[0].scenarioSha256 = createHash("sha256")
        .update(scenario)
        .digest("hex");
      assert.throws(
        () =>
          parseReplay(
            JSON.stringify({
              ...run,
              scenario,
              execution: { ...run.execution, profile: orderProfile },
              environment: {
                ...run.environment,
                executor: `${orderProfile}/1`,
              },
              trace: relabeled.map(canonical).join("\n") + "\n",
            }),
          ),
        /does not support runtime lifecycle/,
      );
      if (committed) {
        const saved = join(input.directory, "run.json");
        await writeFile(saved, JSON.stringify(run));
        assert.equal(
          (
            await replayDocument(saved, {
              jar,
              diagnosticDirectory: input.directory,
            })
          ).status,
          "verified",
        );
      }
    });
  }
}
