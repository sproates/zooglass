import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { AssertionError } from "node:assert";
import { runProof, type ProofResult } from "./proof.js";
const [
  scenario = "receipt",
  output,
  jar = "../zooglass/simulation-host/target/zooglass-simulation.jar",
  seed = "0".repeat(64),
  hostDelay = "0",
  mode = "fast",
] = process.argv.slice(2);
if (
  !(scenario === "receipt" || scenario === "delivery") ||
  !output ||
  !["fast", "paced", "no-alarms"].includes(mode)
) {
  throw new Error(
    "Usage: run.ts receipt|delivery OUTPUT [JAR SEED HOST_DELAY fast|paced|no-alarms]",
  );
}
try {
  const result = await runProof({
    jar: resolve(jar),
    scenario,
    seed,
    hostDelay: Number(hostDelay),
    paced: mode === "paced",
    disableAlarms: mode === "no-alarms",
  });
  await writeFile(output, JSON.stringify(result) + "\n");
} catch (error) {
  const failure = error as Error & { proof?: ProofResult };
  await writeFile(
    output,
    JSON.stringify({
      ...failure.proof,
      outcome:
        error instanceof AssertionError
          ? "assertion-failed"
          : "infrastructure-failed",
      message: failure.message,
    }) + "\n",
  );
  throw error;
}
