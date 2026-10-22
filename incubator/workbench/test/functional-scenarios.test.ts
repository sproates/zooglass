import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";

const scenariosDirectory = join(process.cwd(), "scenarios");

async function runScenario(path: string): Promise<string> {
  const child = spawn("npm", ["run", "integrate", "--", path], {
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
    `Scenario ${path} failed (signal: ${String(signal)}):\n${output}`,
  );

  return output;
}

test(
  "plays every scenario through ZooGlass and checks the resulting views",
  { timeout: 300_000 },
  async () => {
    const scenarioFiles = (await readdir(scenariosDirectory))
      .filter((file) => file.endsWith(".json"))
      .sort();

    assert.ok(scenarioFiles.length > 0, "Expected at least one scenario.");

    for (const filename of scenarioFiles) {
      const path = join(scenariosDirectory, filename);
      const scenario = JSON.parse(await readFile(path, "utf8")) as {
        name: string;
        sources: { id: string }[];
        clients: { id: string; initialState: string }[];
        timeline: { kind: string; clientId?: string; state?: string }[];
      };
      const expectedChecks = scenario.timeline.filter(
        (entry) => entry.kind === "view-check",
      ).length;
      const output = await runScenario(path);

      assert.match(output, new RegExp(`Scenario: ${scenario.name}`));
      assert.equal(
        (output.match(/View check passed:/g) ?? []).length,
        expectedChecks,
        `Expected all view checks to pass for ${filename}.\n${output}`,
      );

      const clientConnections = new Map(
        scenario.clients.map((client) => [
          client.id,
          client.initialState === "connecting" ||
            client.initialState === "connected",
        ]),
      );
      let expectedConnections = scenario.sources.length;
      for (const entry of scenario.timeline) {
        if (entry.kind !== "client-state" || entry.clientId === undefined) {
          continue;
        }

        const connected = clientConnections.get(entry.clientId) ?? false;
        if (
          !connected &&
          (entry.state === "connecting" || entry.state === "connected")
        ) {
          expectedConnections += 1;
          clientConnections.set(entry.clientId, true);
        } else if (
          connected &&
          (entry.state === "disconnecting" || entry.state === "disconnected")
        ) {
          clientConnections.set(entry.clientId, false);
        }
      }

      assert.equal(
        (output.match(/WebSocket client connected:/g) ?? []).length,
        expectedConnections,
        `Expected client connection behavior to run for ${filename}.\n${output}`,
      );
      assert.equal(
        (output.match(/WebSocket client disconnected:/g) ?? []).length,
        expectedConnections,
        `Expected client disconnection behavior to run for ${filename}.\n${output}`,
      );
    }
  },
);
