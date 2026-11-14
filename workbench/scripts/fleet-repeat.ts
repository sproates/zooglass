import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../src/timeline/json.js";
import { fleetProfile } from "../src/timeline/evidence-versions.js";
import { checkFleetCampaignRun } from "./fleet-campaign-checks.js";
import { runRestartCampaign } from "./restart-campaign.js";

await runRestartCampaign({
  format: "timeline-fleet-campaign/v1",
  command: "timeline:fleet-repeat",
  profile: fleetProfile,
  files: [
    "scripts/fleet-repeat.ts",
    "scripts/fleet-campaign-checks.ts",
    "scenarios/timeline-fleet/author.ts",
    "scenarios/timeline-fleet/scenario.json",
    "scenarios/timeline-fleet/runtime.json",
  ],
  inputs: async (directory) => {
    const files = new URL("../scenarios/timeline-fleet/", import.meta.url);
    const bytes =
      canonicalJson(await readFile(new URL("scenario.json", files), "utf8")) +
      "\n";
    await writeFile(join(directory, "scenario.json"), bytes, { flag: "wx" });
    await writeFile(
      join(directory, "runtime.json"),
      await readFile(new URL("runtime.json", files)),
      { flag: "wx" },
    );
    return {
      configuration: "runtime.json",
      groups: [
        {
          id: "fleet",
          filename: "scenario.json",
          path: join(directory, "scenario.json"),
          bytes,
          expected: { assertions: 62, receipts: 16, frames: 28, records: 432 },
        },
      ],
    };
  },
  check: checkFleetCampaignRun,
});
