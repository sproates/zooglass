import { checkLifecycleCampaignRun } from "./lifecycle-campaign-checks.js";
import { lifecycleCampaignInputs } from "./lifecycle-campaign-inputs.js";
import { runRestartCampaign } from "./restart-campaign.js";

await runRestartCampaign({
  format: "timeline-lifecycle-campaign/v1",
  command: "timeline:lifecycle-repeat",
  files: [
    "scripts/lifecycle-repeat.ts",
    "scripts/lifecycle-campaign-inputs.ts",
    "scripts/lifecycle-campaign-checks.ts",
    "scenarios/simulation/memory-restart.json",
    "scenarios/simulation/memory-restart-runtime.json",
  ],
  inputs: lifecycleCampaignInputs,
  check: checkLifecycleCampaignRun,
});
