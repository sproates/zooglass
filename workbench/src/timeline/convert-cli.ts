import { resolve } from "node:path";
import { convertLegacyScenario } from "./conversion.js";

const usage =
  "Usage: timeline:convert LEGACY.json NEW_DIRECTORY --runtime CONFIG.json --epoch-ms INTEGER --seed HEX [--jar HOST.jar]";
const [legacy, directory, ...rest] = process.argv.slice(2);
if (!legacy || !directory || rest.length % 2) throw new Error(usage);
const values = new Map<string, string>();
for (let i = 0; i < rest.length; i += 2) {
  const name = rest[i];
  if (
    !["--runtime", "--epoch-ms", "--seed", "--jar"].includes(name) ||
    values.has(name)
  )
    throw new Error(usage);
  values.set(name, rest[i + 1]);
}
const runtime = values.get("--runtime");
const epoch = values.get("--epoch-ms");
const seed = values.get("--seed");
if (!runtime || !epoch || !/^(0|[1-9][0-9]*)$/.test(epoch) || !seed)
  throw new Error(usage);
console.log(
  JSON.stringify(
    await convertLegacyScenario(legacy, directory, {
      runtime,
      epochMillis: Number(epoch),
      seed,
      jar:
        values.get("--jar") ??
        process.env.ZOOGLASS_SIMULATION_JAR ??
        resolve("../zooglass/simulation-host/target/zooglass-simulation.jar"),
    }),
  ),
);
