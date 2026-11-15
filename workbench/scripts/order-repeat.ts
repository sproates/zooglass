import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../src/timeline/json.js";
import {
  authoredOrderDocument,
  checkOrderCampaignRun,
  orderCounts,
} from "./order-campaign-checks.js";
import { runRestartCampaign } from "./restart-campaign.js";

await runRestartCampaign({
  format: "timeline-order-campaign/v1",
  command: "timeline:order-repeat",
  qualificationRepetitions: 3,
  // Ordinary Order executes 580 host commands: 90ms per command already exceeds
  // the default30s watchdog. Allow120s per fresh run, including pacing/startup.
  watchdogMs: 120_000,
  sqlite: true,
  files: [
    "scripts/order-repeat.ts",
    "scripts/order-campaign-checks.ts",
    ...[
      "author.ts",
      "inputs.ts",
      "receipts.ts",
      "observations.ts",
      "order-one.ts",
      "checkpoints.ts",
      "scenario.json",
      "runtime.json",
    ].map((name) => `scenarios/timeline-order/${name}`),
    ...[
      "author.ts",
      "inputs.ts",
      "oracle.ts",
      "before.json",
      "at.json",
      "after.json",
      "runtime.json",
    ].map((name) => `scenarios/timeline-order-recovery/${name}`),
    ...[
      "author.ts",
      "inputs.ts",
      "oracle.ts",
      "scenario.json",
      "runtime.json",
    ].map((name) => `scenarios/timeline-order-retention/${name}`),
  ],
  inputs: async (directory) => {
    const configuration = await readFile(
      new URL("../scenarios/timeline-order/runtime.json", import.meta.url),
    );
    await writeFile(join(directory, "runtime.json"), configuration, {
      flag: "wx",
    });
    const groups = [];
    for (const expected of orderCounts) {
      const document = authoredOrderDocument(expected.group);
      const folder =
        expected.group === "ordinary"
          ? "timeline-order"
          : expected.group === "retention"
            ? "timeline-order-retention"
            : "timeline-order-recovery";
      const filename = `${expected.group}.json`;
      const source =
        expected.group === "ordinary" || expected.group === "retention"
          ? "scenario.json"
          : filename;
      const files = new URL(`../scenarios/${folder}/`, import.meta.url);
      assert.deepEqual(
        await readFile(new URL("runtime.json", files)),
        configuration,
        "each Order group preserves the exact accepted configuration",
      );
      const bytes =
        canonicalJson(await readFile(new URL(source, files), "utf8")) + "\n";
      assert.equal(
        bytes,
        canonicalJson(JSON.stringify(document)) + "\n",
        "retained Order input differs from authored document",
      );
      const path = join(directory, filename);
      await writeFile(path, bytes, { flag: "wx" });
      groups.push({
        id: expected.group,
        filename,
        path,
        bytes,
        profile: document.runtime.profile,
        expected,
      });
    }
    return { configuration: "runtime.json", groups };
  },
  check: checkOrderCampaignRun,
});
