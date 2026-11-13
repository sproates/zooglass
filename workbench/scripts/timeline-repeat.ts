import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { compareReplay, type ProofResult } from "../src/timeline/proof.js";
const [
  folder = "../../artifacts/timeline-proof",
  jar = "../zooglass/target/zooglass.jar",
] = process.argv.slice(2);
const directory = resolve(folder);
await mkdir(directory, { recursive: true });
const expected = new Map<string, ProofResult>();
for (let iteration = 0; iteration < 100; iteration++) {
  for (const scenario of ["receipt", "delivery"]) {
    const output = join(directory, `${scenario}-${iteration}.json`);
    await new Promise<void>((resolveRun, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/timeline/run.ts",
          scenario,
          output,
          resolve(jar),
          "0".repeat(64),
          String(iteration % 3),
          iteration % 2 ? "paced" : "fast",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let error = "";
      child.stderr.on("data", (chunk) => {
        error = (error + String(chunk)).slice(-16000);
      });
      const watchdog = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Fresh-process watchdog expired"));
      }, 30000);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(watchdog);
        if (code === 0) {
          resolveRun();
        } else {
          reject(new Error(error));
        }
      });
    });
    const actual = JSON.parse(await readFile(output, "utf8")) as ProofResult;
    if (expected.has(scenario)) {
      compareReplay(expected.get(scenario)!, actual);
    } else {
      expected.set(scenario, actual);
    }
  }
  if ((iteration + 1) % 10 === 0) {
    console.log(`Verified ${iteration + 1}/100 fresh pairs per scenario`);
  }
}
assert.equal(expected.size, 2);
await writeFile(
  join(directory, "summary.json"),
  JSON.stringify(
    {
      repetitionsPerScenario: 100,
      freshNodeJvmPairs: 200,
      modes: ["fast", "paced"],
      bridgeDelaysMs: [0, 1, 2],
      manifests: [...expected.values()].map((result) => result.manifest),
      result: "passed",
    },
    null,
    2,
  ) + "\n",
);
