import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scenarioPath = fileURLToPath(
  new URL("./fixtures/workbench-zooglass.json", import.meta.url),
);

test(
  "runs a scenario through ZooGlass over WebSocket connections",
  { timeout: 120_000 },
  async () => {
    const child = spawn("npm", ["run", "integrate", "--", scenarioPath], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      output += chunk;
    });

    const [exitCode, signal] = await once(child, "close");

    assert.equal(
      exitCode,
      0,
      `Connected scenario failed (signal: ${String(signal)}):\n${output}`,
    );
    assert.match(
      output,
      /Scenario: Workbench drives ZooGlass connections and events/,
    );
    assert.match(output, /Received event from client .+: .*"marker":"first"/);
    assert.match(
      output,
      /Received event from client .+: .*"marker":"during-disconnect"/,
    );
    assert.match(
      output,
      /Received event from client .+: .*"marker":"after-reconnect"/,
    );
    assert.equal(
      (output.match(/WebSocket client connected:/g) ?? []).length,
      3,
    );
    assert.equal(
      (output.match(/WebSocket client disconnected:/g) ?? []).length,
      3,
    );
  },
);
