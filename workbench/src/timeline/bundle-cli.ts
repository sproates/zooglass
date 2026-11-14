import {
  resolve,
  relative,
  isAbsolute,
  dirname,
  basename,
  sep,
} from "node:path";
import { realpath, writeFile } from "node:fs/promises";
import { recordBundle, replayBundle } from "./artifact-bundle.js";

import { replayArguments, replayExitCode } from "./replay-policy.js";
const { positional, verificationOnly, hasPolicy } = replayArguments(
  process.argv.slice(2),
);
const [
  command,
  input,
  output,
  jar = "../zooglass/simulation-host/target/zooglass-simulation.jar",
] = positional;
if (
  !["record", "replay"].includes(command) ||
  !input ||
  !output ||
  positional.length > 4 ||
  (command === "record" && hasPolicy)
)
  throw new Error(
    "Usage: timeline:bundle record SCENARIO NEW_DIRECTORY [JAR] | replay DIRECTORY REPORT.json [JAR] [--verification-only]",
  );

if (command === "record") {
  const result = await recordBundle(resolve(input), resolve(output), {
    jar: resolve(jar),
  });
  if (result.outcome !== "passed") process.exitCode = 1;
} else {
  // Resolve the output parent too, so a symlink alias cannot place reports inside evidence.
  const destination = resolve(
    await realpath(dirname(resolve(output))),
    basename(output),
  );
  const path = relative(await realpath(input), destination);
  if (
    !path ||
    (!path.startsWith(".." + sep) && path !== ".." && !isAbsolute(path))
  )
    throw new Error("Replay report must be outside the evidence directory");
  const report = await replayBundle(resolve(input), { jar: resolve(jar) });
  await writeFile(destination, JSON.stringify(report) + "\n", { flag: "wx" });
  process.exitCode = replayExitCode(report, verificationOnly);
}
