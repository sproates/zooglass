import assert, { AssertionError } from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  runProof,
  compareReplay,
  type ProofResult,
} from "../src/timeline/proof.js";
const [artifact, folder = "../../artifacts/timeline-mutation-evidence"] =
  process.argv.slice(2);
if (!artifact) {
  throw new Error("Supply a separately prepared mutation JAR");
}
const directory = resolve(folder);
await mkdir(directory, { recursive: true });
const results: ProofResult[] = [];
for (let iteration = 0; iteration < 2; iteration++) {
  let failed = false;
  try {
    await runProof({
      jar: resolve(artifact),
      scenario: "receipt",
      seed: "0".repeat(64),
      hostDelay: iteration,
    });
  } catch (error) {
    assert.ok(
      error instanceof AssertionError,
      "mutation must reach a behavioural assertion",
    );
    assert.match(error.message, /deadline must expire before same-time input/);
    const proof = (error as AssertionError & { proof: ProofResult }).proof;
    assert.ok(
      proof?.trace.length > 0,
      "mutation must preserve executed effects",
    );
    results.push(proof);
    failed = true;
    await writeFile(
      join(directory, `mutation-${iteration}.json`),
      JSON.stringify({
        ...proof,
        outcome: "assertion-failed",
        message: error.message,
      }) + "\n",
    );
  }
  assert.equal(failed, true, "mutation unexpectedly passed");
}
compareReplay(results[0], results[1]);
await writeFile(
  join(directory, "summary.json"),
  JSON.stringify(
    {
      result: "passed-negative-control",
      assertion: "deadline must expire before same-time input",
      wrongTraceRepeatable: true,
      manifest: results[0].manifest,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Mutation executed twice: repeatable wrong trace rejected by freshness oracle",
);
