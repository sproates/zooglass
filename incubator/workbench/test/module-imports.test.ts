import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

test("session modules can be imported without starting a service or running the CLI", async () => {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'await import("./src/scenario-session.ts"); await import("./src/zooglass-session.ts"); await import("./src/namespace-scenario.ts");',
    ],
    { timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  assert.deepEqual(await once(child, "close"), [0, null]);
  assert.equal(output, "");
});
