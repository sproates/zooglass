import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Explicit preparation only. Session startup must never call this script.
const args = ["--batch-mode", "-Dmaven.test.skip=true", "package"];

const child = spawn(
  process.platform === "win32" ? "mvnw.cmd" : "./mvnw",
  args,
  {
    cwd: fileURLToPath(new URL("../../zooglass/", import.meta.url)),
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);
child.once("error", (error) => {
  console.error(`Could not prepare ZooGlass: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
