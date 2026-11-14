import assert from "node:assert/strict";
import type { DocumentRun } from "../src/timeline/campaign-checks.js";
import { evidenceV2 } from "../src/timeline/evidence-versions.js";
import { parseJson } from "../src/timeline/json.js";
import { parseReplay } from "../src/timeline/replay-document.js";
import { integer, list, object } from "../src/timeline/validation.js";

/** Load complete v2 evidence and optionally locate the first record that differs. */
export function restartEvidence(
  raw: string,
  baseline: DocumentRun | undefined,
  storage: "memory" | "sqlite",
) {
  const run: DocumentRun = JSON.parse(raw);
  assert.equal(run.outcome, "passed", run.message ?? "scenario failed");
  if (baseline) {
    assert.deepEqual(
      run.execution,
      baseline.execution,
      "execution identity drift",
    );
    assert.deepEqual(
      run.environment,
      baseline.environment,
      "environment drift",
    );
    assert.equal(run.scenario, baseline.scenario, "scenario drift");
    assert.equal(
      run.configuration,
      baseline.configuration,
      "configuration drift",
    );
    if (run.trace !== baseline.trace) {
      const actual = run.trace.split("\n");
      const prior = baseline.trace.split("\n");
      const firstDifference = actual.findIndex(
        (line, index) => line !== prior[index],
      );
      throw new Error(
        `semantic trace divergence at record ${firstDifference < 0 ? actual.length : firstDifference}`,
      );
    }
  }

  const parsed = parseReplay(raw);
  assert.equal(
    parsed.versions,
    evidenceV2,
    "restart qualification requires v2 evidence",
  );
  assert.equal(parsed.scenario.storage, storage, "qualified scenario storage");
  const events = parsed.lines.slice(1, -1).map((line) => {
    const record = object(parseJson(line), "event");
    return {
      kind: record.kind,
      id: record.eventId,
      parent: record.parentId,
      causes: record.causes === undefined ? [] : list(record.causes, "causes"),
      generation:
        record.runtimeGeneration === null
          ? null
          : integer(record.runtimeGeneration, "runtimeGeneration"),
      connection:
        record.connectionGeneration === null
          ? null
          : integer(record.connectionGeneration, "connectionGeneration"),
      time: integer(list(record.key, "key")[0], "time"),
      data: object(record.data, "data"),
    };
  });
  return {
    run,
    parsed,
    byKind: (kind: string) => events.filter((event) => event.kind === kind),
  };
}
