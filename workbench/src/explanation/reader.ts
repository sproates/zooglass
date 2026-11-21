import { realpath, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { readBundle } from "../timeline/artifact-bundle.js";
import { explanationModel } from "./model.js";
import { renderExplanation } from "./render.js";

/** This operation validates retained evidence only. It never executes or replays Java. */
export async function explainBundle(directory: string, selected?: string) {
  const run = await readBundle(directory);
  return explanationModel(
    {
      profile: run.scenario.profile,
      outcome: run.outcome,
      format: run.trace.header.format,
      evidence: run.evidence,
      events: run.trace.events,
      publicationDecisions: run.trace.publicationDecisions,
    },
    selected,
  );
}

export async function writeExplanation(
  directory: string,
  output: string,
  format: "text" | "json",
  selected?: string,
) {
  const destination = resolve(
    await realpath(dirname(resolve(output))),
    basename(output),
  );
  const path = relative(await realpath(directory), destination);
  if (
    !path ||
    (!path.startsWith(".." + sep) && path !== ".." && !isAbsolute(path))
  )
    throw new Error(
      "Explanation report must be outside the evidence directory",
    );
  const report = await explainBundle(directory, selected);
  const rendered = renderExplanation(report, format);
  await writeFile(destination, rendered, { flag: "wx" });
  return report.recordedOutcome === "passed" ? 0 : 2;
}
