import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../src/timeline/json.js";
import { runRestartCampaign } from "./restart-campaign.js";
import {
  authoredSportsDocument,
  checkSportsCampaignRun,
  sportsCounts,
} from "./sports-campaign-checks.js";
const scenarioFiles: string[] = [];
for (const folder of ["timeline-sports", "timeline-sports-retention"]) {
  for (const name of (
    await readdir(new URL(`../scenarios/${folder}/`, import.meta.url))
  ).sort())
    if (name.endsWith(".ts") || name.endsWith(".json"))
      scenarioFiles.push(`scenarios/${folder}/${name}`);
}
await runRestartCampaign({
  format: "timeline-sports-campaign/v1",
  command: "timeline:sports-repeat",
  profile: "sqlite-sports-v1",
  qualificationRepetitions: 3,
  watchdogMs: 120_000,
  sqlite: true,
  files: [
    "scripts/sports-repeat.ts",
    "scripts/sports-campaign-checks.ts",
    ...scenarioFiles,
  ],
  inputs: async (directory) => {
    const configuration = await readFile(
      new URL("../scenarios/timeline-sports/runtime.json", import.meta.url),
    );
    await writeFile(join(directory, "runtime.json"), configuration, {
      flag: "wx",
    });
    const groups = [];
    for (const expected of sportsCounts) {
      const folder =
        expected.group === "ordinary"
          ? "timeline-sports"
          : "timeline-sports-retention";
      const document = authoredSportsDocument(expected.group);
      assert.deepEqual(
        await readFile(
          new URL(`../scenarios/${folder}/runtime.json`, import.meta.url),
        ),
        configuration,
      );
      const bytes =
        canonicalJson(
          await readFile(
            new URL(`../scenarios/${folder}/scenario.json`, import.meta.url),
            "utf8",
          ),
        ) + "\n";
      assert.equal(
        bytes,
        canonicalJson(JSON.stringify(document)) + "\n",
        "retained scenario differs from authored expectations",
      );
      const filename = `${expected.group}.json`,
        path = join(directory, filename);
      await writeFile(path, bytes, { flag: "wx" });
      groups.push({ id: expected.group, filename, path, bytes, expected });
    }
    return { configuration: "runtime.json", groups };
  },
  check: checkSportsCampaignRun,
});
