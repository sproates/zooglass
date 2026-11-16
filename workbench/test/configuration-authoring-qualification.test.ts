import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  startZooGlassSession,
  type ZooGlassSession,
} from "../src/service/zooglass-session.js";
import { jar, runConfiguration } from "./support/configuration-command.js";
import { examples, verifyExample } from "./support/configuration-examples.js";

const execute = promisify(execFile);
const authoredFile = join(examples, "sales.authored.json");
const ordinaryFile = join(examples, "sales-sqlite.json");

async function expand(input: string, output: string) {
  const result = await runConfiguration([
    "expand",
    input,
    "--output",
    output,
    "--json",
  ]);
  assert.equal(result.code, 0, result.stdout);
  return JSON.parse(result.stdout);
}

async function explain(input: string) {
  const result = await runConfiguration(["explain", input, "--json"]);
  assert.equal(result.code, 0, result.stdout);
  return JSON.parse(result.stdout);
}

test("authoring qualification compares every effective setting, including root and delivery bounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "authoring-equivalence-"));
  try {
    const output = join(directory, "expanded.json");
    await expand(authoredFile, output);
    const ordinary = await explain(ordinaryFile);
    const authored = await explain(authoredFile);
    const expanded = await explain(output);
    assert.deepEqual(
      authored.explanation.effective,
      ordinary.explanation.effective,
    );
    assert.deepEqual(
      expanded.explanation.effective,
      ordinary.explanation.effective,
    );
    assert.deepEqual(authored.notChecked, [
      "deployment",
      "existingDatabaseCompatibility",
      "timelineEligibility",
    ]);

    // Explicit default declarations change provenance, not the effective configuration.
    const equivalent = JSON.parse(await readFile(ordinaryFile, "utf8"));
    equivalent.delivery = {
      recovery: "freshSnapshot",
      slowClient: "disconnectOnOverflow",
      maxQueuedMessages: 128,
      maxQueuedBytes: 1048576,
    };
    const explicit = join(directory, "explicit-defaults.json");
    await writeFile(explicit, JSON.stringify(equivalent));
    const explicitReport = await explain(explicit);
    assert.deepEqual(
      explicitReport.explanation.effective,
      ordinary.explanation.effective,
    );
    assert.notDeepEqual(
      explicitReport.explanation.defaults,
      ordinary.explanation.defaults,
    );

    // Each independently valid change must remain visible; no comparison whitelist.
    for (const key of [
      "maxStreams",
      "identityWindow",
      "maxHistoryEntries",
      "maxQueuedMessages",
      "maxQueuedBytes",
    ]) {
      const changed = structuredClone(equivalent);
      if (key.startsWith("maxQueued")) changed.delivery[key] += 1;
      else changed[key] += 1;
      const path = join(directory, `${key}.json`);
      await writeFile(path, JSON.stringify(changed));
      const report = await explain(path);
      assert.notDeepEqual(
        report.explanation.effective,
        ordinary.explanation.effective,
        key,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expanded sales survive SQLite restart and an incompatible-template attempt without losing state or receipt identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "authoring-recovery-"));
  let service: ZooGlassSession | undefined;
  try {
    const output = join(directory, "sales.runtime.json");
    await expand(authoredFile, output);
    const options = {
      runtimeConfigurationPath: output,
      databasePath: join(directory, "state.sqlite"),
    };
    service = await startZooGlassSession(options);
    const before = await verifyExample("sales", service.baseUrl);
    await service.close();
    service = undefined;

    service = await startZooGlassSession(options);
    const restarted = await verifyExample("sales-restart", service.baseUrl);
    assert.deepEqual(restarted, before);
    await service.close();
    service = undefined;

    const changed = JSON.parse(await readFile(authoredFile, "utf8"));
    changed.fieldTemplates.sale.facts.maxRetainedFacts = 101;
    const changedInput = join(directory, "changed.authored.json");
    const changedOutput = join(directory, "changed.runtime.json");
    await writeFile(changedInput, JSON.stringify(changed));
    const report = await expand(changedInput, changedOutput);
    assert.equal(report.valid, true);
    assert.ok(report.notChecked.includes("existingDatabaseCompatibility"));
    await assert.rejects(
      execute(
        "java",
        [
          "-jar",
          jar,
          "--server.address=127.0.0.1",
          "--server.port=0",
          `--zooglass.config=${pathToFileURL(changedOutput).href}`,
          `--zooglass.database=${options.databasePath}`,
        ],
        { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
      ),
      (error: unknown) => {
        const failed = error as {
          code: unknown;
          killed: boolean;
          stdout: string;
          stderr: string;
        };
        assert.equal(
          failed.killed,
          false,
          "startup must reject, not hang until timeout",
        );
        assert.equal(failed.code, 1);
        assert.match(
          failed.stdout + failed.stderr,
          /Stored configuration conflicts with startup configuration/,
        );
        return true;
      },
    );

    // Reopen the same store with its original definition after the refused startup.
    service = await startZooGlassSession(options);
    const recovered = await verifyExample("sales-restart", service.baseUrl);
    assert.deepEqual(recovered, before);
  } finally {
    await service?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
