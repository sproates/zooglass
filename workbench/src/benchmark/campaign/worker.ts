import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { openCampaign } from "./journal.js";
import { readRecord } from "./journal-files.js";
import { executionIdentity, hostConditions } from "./identity.js";
import { makeManifest } from "./plan.js";
import { verifyResult } from "./evidence.js";
import { runCampaign } from "./runner.js";
import type { CampaignManifest } from "./model.js";

const startedMs = performance.now();
const [mode, target, count, description] = process.argv.slice(2);
let pause = false;
process.on("SIGINT", () => {
  pause = true;
});
process.on("SIGTERM", () => {
  pause = true;
});
try {
  if (
    (mode !== "create" && mode !== "resume") ||
    !target ||
    !description ||
    !/^\d+$/.test(count) ||
    Number(count) < 1 ||
    Number(count) > 66
  )
    throw new Error("Invalid campaign worker arguments");
  const directory = resolve(target);
  const lockFd = Number(process.env.ZOOGLASS_CAMPAIGN_LOCK_FD);
  const manifest =
    mode === "create"
      ? makeManifest(randomUUID(), await executionIdentity(directory))
      : await readRecord<CampaignManifest>(join(directory, "manifest.json"));
  const journal = await openCampaign(directory, {
    mode,
    manifest,
    lockFd,
    startedMs,
    conditions: hostConditions(description),
    verifyResult,
    async verifyIdentity(checkpoint) {
      if (mode === "create") return;
      await checkpoint();
      const current = makeManifest(
        manifest.campaignId,
        await executionIdentity(directory, checkpoint),
      );
      await checkpoint();
      if (!isDeepStrictEqual(manifest, current))
        throw new Error(
          "Execution identity or campaign inputs changed; create a new campaign",
        );
    },
  });
  console.log(
    await runCampaign(journal, manifest, lockFd, Number(count), () => pause),
  );
} catch (cause) {
  console.error(String(cause));
  process.exitCode = 1;
}
