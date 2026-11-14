import { runRestartCampaign } from "./restart-campaign.js";
import { checkSqliteCampaignRun } from "./sqlite-campaign-checks.js";
import { sqliteCampaignInputs } from "./sqlite-campaign-inputs.js";

await runRestartCampaign({
  format: "timeline-sqlite-campaign/v1",
  command: "timeline:sqlite-repeat",
  sqlite: true,
  files: [
    "scripts/sqlite-repeat.ts",
    "scripts/sqlite-campaign-inputs.ts",
    "scripts/sqlite-campaign-checks.ts",
    "scenarios/simulation/sqlite-restart.json",
    "scenarios/simulation/sqlite-restart-runtime.json",
    "scenarios/simulation/sqlite-wall-rollback.json",
    "scenarios/simulation/sqlite-wall-runtime.json",
  ],
  inputs: sqliteCampaignInputs,
  check: checkSqliteCampaignRun,
});
