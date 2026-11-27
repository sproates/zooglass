import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { workbenchDirectory } from "../campaign/identity.js";
import { lockScript } from "../campaign/ownership.js";

try {
  const [target, flag, conditions, mode, ...extra] = process.argv.slice(2);
  if (
    !target ||
    flag !== "--conditions" ||
    !conditions?.trim() ||
    (mode !== undefined && mode !== "--smoke") ||
    extra.length
  )
    throw new Error(
      'Usage: benchmark:sqlite-profile DIRECTORY --conditions "observed host conditions" [--smoke]',
    );
  const directory = resolve(target);
  // Refuse both overwrite and resume: this experiment is exactly one pair.
  await mkdir(directory);
  const child = spawn(
    "python3",
    [
      lockScript,
      directory,
      process.execPath,
      "--import",
      "tsx",
      join(workbenchDirectory, "src/benchmark/profile/worker.ts"),
      directory,
      conditions,
      ...(mode ? [mode] : []),
    ],
    { stdio: "inherit", cwd: workbenchDirectory },
  );
  const cancel = () => child.kill("SIGTERM");
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
} catch (cause) {
  console.error(String(cause));
  process.exitCode = 1;
}
