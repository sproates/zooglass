import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Explicit preparation only. Tests and runtime startup never call this script.
const root = fileURLToPath(new URL("../../zooglass/", import.meta.url));
const wrapper = process.platform === "win32" ? "mvnw.cmd" : "./mvnw";
for (const args of [
  ["--batch-mode", "-DskipTests", "install"],
  ["--batch-mode", "-f", "simulation-host/pom.xml", "-DskipTests", "package"],
]) {
  const result = spawnSync(wrapper, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await import("./check-timeline-artifacts.js");
