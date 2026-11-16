import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

export const examples = resolve("../zooglass/docs/examples/configuration");
const run = promisify(execFile);

/** The example script checks literal receipts and snapshots through real service interfaces. */
export async function verifyExample(mode: string, baseUrl: string) {
  const { stdout } = await run(
    process.execPath,
    [join(examples, "run-example.mjs"), mode, baseUrl],
    { timeout: 20_000 },
  );
  return JSON.parse(stdout);
}
