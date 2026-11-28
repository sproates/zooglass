import { readFile, appendFile } from "node:fs/promises";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { encodeJson, type Json } from "../json/lossless.js";
import { docker } from "../ha-fixture/docker.js";
export interface RunOptions {
  output: string;
  cases: number[];
  extraPauses: boolean;
}
export function options(args: readonly string[]): RunOptions {
  let output: string | undefined,
    selection: number[] | undefined,
    extraPauses = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`Repeated option ${flag}`);
    seen.add(flag);
    if (flag === "--extra-pauses") {
      extraPauses = true;
      continue;
    }
    if (!["--output", "--case", "--cases"].includes(flag))
      throw new Error(`Unknown option ${flag}`);
    const value = args[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${flag}`);
    if (flag === "--output") output = resolve(value);
    else {
      if (selection) throw new Error("Choose --case or --cases, not both");
      if (
        !/^[0-9]+(?:,[0-9]+)*$/.test(value) ||
        (flag === "--case" && value.includes(","))
      )
        throw new Error("Expected fixed case numbers");
      selection = value.split(",").map(Number);
      if (
        selection.some((id) => id < 1 || id > 14) ||
        new Set(selection).size !== selection.length
      )
        throw new Error("Cases must be unique numbers from 1 to 14");
    }
  }
  if (!output) throw new Error("--output must name a new report directory");
  return {
    output,
    cases: selection ?? Array.from({ length: 14 }, (_, i) => i + 1),
    extraPauses,
  };
}
export class Observations {
  private readonly fd: number;
  private count = 0;
  private bytes = 0;
  constructor(readonly path: string) {
    this.fd = openSync(path, "wx", 0o600);
  }
  record(name: string, data: Json = null): void {
    if (!name || name.length > 128) throw new Error("Invalid observation name");
    const line =
      encodeJson({ sequence: String(this.count + 1), name, data }) + "\n";
    if (
      this.count >= 10000 ||
      this.bytes + Buffer.byteLength(line) > 16 * 1024 * 1024
    )
      throw new Error("Fault observation evidence exceeds bound");
    appendFileSync(this.fd, line);
    this.count++;
    this.bytes += Buffer.byteLength(line);
  }
  close(): number {
    closeSync(this.fd);
    return this.count;
  }
}
export async function verifyCleanup(directory: string): Promise<string> {
  let journal: { runId: string; network: string; containers: string[] };
  try {
    journal = JSON.parse(
      await readFile(join(directory, "ownership.json"), "utf8"),
    ) as typeof journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return "no-resources-created";
    throw error;
  }
  if (!/^[0-9a-f]{12}$/.test(journal.runId))
    throw new Error("Invalid fixture ownership journal");
  for (const kind of ["containers", "networks"] as const) {
    const args = kind === "containers" ? ["ps", "-a"] : ["network", "ls"];
    const retained = await docker(
      [
        ...args,
        "--filter",
        `label=zooglass.ha-fixture=${journal.runId}`,
        "--format",
        kind === "containers" ? "{{.Names}}" : "{{.Name}}",
      ],
      undefined,
      AbortSignal.timeout(10000),
    );
    if (retained.trim())
      throw new Error(`Owned ${kind} remain after cleanup: ${retained}`);
  }
  await appendFile(
    join(directory, "cleanup-verified.txt"),
    `Owned containers and network absent: ${journal.runId}\n`,
  );
  return "verified-absent";
}
export function failure(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message.slice(0, 4096) }
    : { name: "Error", message: String(error).slice(0, 4096) };
}
