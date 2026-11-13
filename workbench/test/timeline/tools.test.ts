import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { campaignInputs } from "../../scripts/document-campaign-inputs.js";
import { fixture } from "./document-fixture.js";

test("scenario inspection rejects malformed UTF-8 inside a valid document", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timeline-inspection-"));
  try {
    const path = join(directory, "scenario.json");
    const document = fixture().document;
    document.id = "inspect-utf8-§";
    document.runtime.sha256 = "a".repeat(64);
    const raw = JSON.stringify(document);
    const [prefix, suffix] = raw.split("§");
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from(prefix),
        Buffer.from([0xff]),
        Buffer.from(suffix),
      ]),
    );
    const report = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/timeline/inspect.ts", "scenario", path],
      { encoding: "utf8" },
    );
    assert.equal(report.status, 1, report.stderr);
    assert.match(report.stderr, /not valid for encoding utf-8/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("campaign seed variants retain exact publication and assertion numbers", async () => {
  const root = await mkdtemp(join(tmpdir(), "timeline-campaign-inputs-"));
  try {
    const source = join(root, "scenarios");
    const output = join(root, "inputs");
    await cp(resolve("scenarios/simulation"), source, { recursive: true });
    await mkdir(output);

    const path = join(source, "warehouse-retry.json");
    const raw = (await readFile(path, "utf8")).replaceAll(
      '"amount": 1',
      '"amount": 9007199254740993, "fraction": 1.0000000000000000001',
    );
    await writeFile(path, raw);
    const groups = await campaignInputs(output, source);
    for (const digit of ["0", "1", "2"]) {
      const group = groups.find(
        ({ id }) => id === `warehouse-retry-seed-${digit}`,
      );
      assert.ok(group);
      const scenario = await readFile(group.path, "utf8");
      assert.equal(JSON.parse(scenario).seed, digit.repeat(64));
      assert.equal(
        scenario.match(/"amount":\s*9007199254740993(?=\s*[,}])/g)?.length,
        4,
      );
      assert.equal(
        scenario.match(/"fraction":\s*1\.0000000000000000001(?=\s*[,}])/g)
          ?.length,
        4,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
