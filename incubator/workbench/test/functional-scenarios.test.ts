import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";

interface ScenarioFixtureSummary {
  name: string;
  sources: { id: string }[];
  clients: { id: string; initialState: string }[];
  timeline: { kind: string; clientId?: string; state?: string }[];
}

const scenariosDirectory = join(process.cwd(), "scenarios");

test(
  "plays every scenario through one ZooGlass process and checks the views",
  { timeout: 120_000 },
  async () => {
    const scenarioFiles = (await readdir(scenariosDirectory))
      .filter((file) => file.endsWith(".json"))
      .sort();

    assert.ok(scenarioFiles.length > 0, "Expected at least one scenario.");

    const scenarios = await Promise.all(
      scenarioFiles.map(async (filename) => ({
        filename,
        path: join(scenariosDirectory, filename),
        data: JSON.parse(
          await readFile(join(scenariosDirectory, filename), "utf8"),
        ) as ScenarioFixtureSummary,
      })),
    );

    const child = spawn(
      "npm",
      [
        "run",
        "integrate",
        "--",
        "--fast",
        ...scenarios.map((scenario) => scenario.path),
      ],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      },
    );

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
      `Scenario suite failed (signal: ${String(signal)}):\n${output}`,
    );
    assert.equal(
      (output.match(/ZooGlass is ready/g) ?? []).length,
      1,
      `Expected one ZooGlass process for the scenario suite.\n${output}`,
    );

    let expectedConnections = 0;
    let expectedViewChecks = 0;
    let expectedClientViewChecks = 0;

    for (const scenario of scenarios) {
      assert.ok(output.includes(`Scenario: ${scenario.data.name}`));
      expectedConnections += scenario.data.sources.length;
      expectedViewChecks += scenario.data.timeline.filter(
        (entry) => entry.kind === "view-check",
      ).length;
      expectedClientViewChecks += scenario.data.timeline.filter(
        (entry) => entry.kind === "client-view-check",
      ).length;

      for (const client of scenario.data.clients) {
        if (
          client.initialState === "connecting" ||
          client.initialState === "connected"
        ) {
          expectedConnections += 1;
        }
      }

      const clientConnections = new Map(
        scenario.data.clients.map((client) => [
          client.id,
          client.initialState === "connecting" ||
            client.initialState === "connected",
        ]),
      );

      for (const entry of scenario.data.timeline) {
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
    }

    assert.equal(
      (output.match(/View (?:check|absence check) passed:/g) ?? []).length,
      expectedViewChecks,
      `Expected all scenario view checks to pass.\n${output}`,
    );
    assert.equal(
      (output.match(/Client view check passed:/g) ?? []).length,
      expectedClientViewChecks,
      `Expected all scenario client view checks to pass.\n${output}`,
    );
    assert.equal(
      (output.match(/WebSocket client connected:/g) ?? []).length,
      expectedConnections,
      `Expected all scenario client connections to run.\n${output}`,
    );
    assert.equal(
      (output.match(/WebSocket client disconnected:/g) ?? []).length,
      expectedConnections,
      `Expected all scenario client disconnections to run.\n${output}`,
    );
  },
);
