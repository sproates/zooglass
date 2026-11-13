import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { inspectAdmission } from "../../src/timeline/admission.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ?? "../zooglass/target/zooglass.jar",
);
const example = resolve("scenarios/simulation/receipt-contract.json");

test("prepared artifact validates real configuration without granting execution", async () => {
  const result = await inspectAdmission(example, jar);
  assert.equal(result.configuration, "valid");
  assert.equal(result.execution, "unsupported");
  assert.deepEqual(result.artifactDocumentFormats, []);
  assert.equal(
    result.artifact,
    createHash("sha256")
      .update(await readFile(jar))
      .digest("hex"),
  );
});

test("configuration hash fails before launching even a missing artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timeline-admission-"));
  try {
    const doc = JSON.parse(await readFile(example, "utf8"));
    await writeFile(join(directory, "receipt-runtime.json"), "{}");
    await writeFile(join(directory, "scenario.json"), JSON.stringify(doc));
    await assert.rejects(
      inspectAdmission(
        join(directory, "scenario.json"),
        "/missing-artifact.jar",
      ),
      /SHA-256 mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production parser rejects correctly hashed unsupported strategy and storage disagreement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timeline-admission-"));
  try {
    const doc = JSON.parse(await readFile(example, "utf8"));
    const configuration = JSON.parse(
      await readFile(
        resolve("scenarios/simulation/receipt-runtime.json"),
        "utf8",
      ),
    );
    configuration.views[0].fields.position.mode = "invented-mode";
    const wire = JSON.stringify(configuration);
    doc.runtime.sha256 = createHash("sha256").update(wire).digest("hex");
    await writeFile(join(directory, "receipt-runtime.json"), wire);
    await writeFile(join(directory, "scenario.json"), JSON.stringify(doc));
    await assert.rejects(
      inspectAdmission(join(directory, "scenario.json"), jar),
      /Runtime exited/,
    );
    configuration.views[0].fields.position.mode = "arrival";
    configuration.storage = "sqlite";
    const other = JSON.stringify(configuration);
    doc.runtime.sha256 = createHash("sha256").update(other).digest("hex");
    await writeFile(join(directory, "receipt-runtime.json"), other);
    await writeFile(join(directory, "scenario.json"), JSON.stringify(doc));
    await assert.rejects(
      inspectAdmission(join(directory, "scenario.json"), jar),
      /disagrees/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
