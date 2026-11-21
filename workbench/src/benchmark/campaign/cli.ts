import { mkdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { workbenchDirectory } from "./identity.js";

const usage =
  'Usage: benchmark:campaign create|resume DIRECTORY --conditions "power, thermal, competing load and storage conditions" [--max-attempts N]';
try {
  const [mode, target, ...options] = process.argv.slice(2);
  if (
    (mode !== "create" && mode !== "resume") ||
    !target ||
    !["darwin", "linux"].includes(process.platform)
  )
    throw new Error(usage);
  let conditions = "",
    count = "66";
  const seen = new Set<string>();
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i],
      value = options[i + 1];
    if (!value || seen.has(key)) throw new Error(usage);
    seen.add(key);
    if (key === "--conditions") conditions = value;
    else if (key === "--max-attempts") count = value;
    else throw new Error(usage);
  }
  if (
    !conditions.trim() ||
    !/^\d+$/.test(count) ||
    Number(count) < 1 ||
    Number(count) > 66
  )
    throw new Error(usage);
  const directory = resolve(target);
  if (mode === "create") await mkdir(directory);
  else if (!(await stat(directory)).isDirectory())
    throw new Error("Campaign directory does not exist");
  const child = spawn(
    "python3",
    [
      join(workbenchDirectory, "scripts/benchmark-lock.py"),
      directory,
      process.execPath,
      "--import",
      "tsx",
      join(workbenchDirectory, "src/benchmark/campaign/worker.ts"),
      mode,
      directory,
      count,
      conditions,
    ],
    { stdio: "inherit", cwd: workbenchDirectory },
  );
  const pause = () => child.kill("SIGTERM");
  process.on("SIGINT", pause);
  process.on("SIGTERM", pause);
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.off("SIGINT", pause);
  process.off("SIGTERM", pause);
  process.exitCode = code;
} catch (cause) {
  console.error(String(cause));
  process.exitCode = 1;
}
