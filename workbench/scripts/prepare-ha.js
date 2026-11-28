import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import "./check-node-version.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--verify"))
  throw new Error("Usage: prepare-ha.js [--verify]");
// This command prepares portable Node modules only. The service and optional fault agent must already exist.
if (!args.includes("--verify")) {
  const result = spawnSync(
    process.execPath,
    ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const prepared = await import("../dist/ha-cases/prepared.js");
if (args.includes("--verify")) await prepared.verifyPreparation();
else await prepared.recordPreparation();
console.log(
  args.includes("--verify")
    ? "HA prepared identities verified."
    : "HA Node modules prepared; existing service and optional fault agent identities recorded.",
);
