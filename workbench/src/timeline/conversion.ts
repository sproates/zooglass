import { link, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Bridge } from "./bridge.js";
import { parseTimelineDocument } from "./contract.js";
import {
  conversionDocument,
  conversionFiles,
  conversionReport,
  type ConversionOptions,
} from "./conversion-document.js";
import {
  conversionInput,
  ConversionEligibilityError,
} from "./conversion-eligibility.js";
import { validateConversionProvenance } from "./conversion-provenance.js";
import { executionSettings } from "./document-profile.js";
import { boundedFile, decode } from "./file-input.js";
import { workbenchIdentity } from "./manifest.js";
import { inspectRequestedConfiguration } from "./requested-admission.js";

export type ConvertLegacyOptions = ConversionOptions & {
  runtime: string;
  jar: string;
};

/** Produce reviewable inputs only. The prepared JVM validates configurations but never starts a runtime. */
export async function convertLegacyScenario(
  legacyPath: string,
  directory: string,
  options: ConvertLegacyOptions,
) {
  const legacy = decode(await boundedFile(resolve(legacyPath)));
  const configuration = decode(await boundedFile(resolve(options.runtime)));
  const input = conversionInput(legacy);
  const preview = conversionDocument(legacy, configuration, options);
  executionSettings(parseTimelineDocument(preview.canonical), configuration);
  const identity = await workbenchIdentity();
  const { bridge, artifact } = await Bridge.open(resolve(options.jar));
  let plan: ReturnType<typeof conversionReport>;
  try {
    const inspection = await inspectRequestedConfiguration(
      bridge,
      configuration,
      input.referenceConfiguration,
    );
    if (
      !inspection.requestedProfile.eligible ||
      !inspection.requestedProfile.comparison?.equivalent
    )
      throw new ConversionEligibilityError(
        [
          ...inspection.requestedProfile.issues,
          ...(inspection.requestedProfile.comparison?.differences ?? []),
        ].map(({ path, rule }) => ({
          path: `configuration${path.slice(1)}`,
          reason: rule,
        })),
      );
    plan = conversionReport(
      legacy,
      configuration,
      { epochMillis: options.epochMillis, seed: options.seed },
      { workbenchSha256: identity, artifactSha256: artifact },
    );
    const scenario = parseTimelineDocument(plan.canonical);
    executionSettings(scenario, configuration);
    validateConversionProvenance(scenario, configuration, {
      report: plan.report,
      legacy,
    });
    if ((await workbenchIdentity()) !== identity)
      throw new Error(
        "invalid-conversion: converter modules changed during admission",
      );
  } finally {
    await bridge.close();
  }
  const destination = resolve(directory);
  await mkdir(destination);
  try {
    await writeFile(join(destination, conversionFiles.legacy), legacy, {
      flag: "wx",
    });
    await writeFile(
      join(destination, conversionFiles.configuration),
      configuration,
      { flag: "wx" },
    );
    await writeFile(join(destination, conversionFiles.report), plan.report, {
      flag: "wx",
    });
    const pending = join(destination, "scenario.pending");
    await writeFile(pending, plan.canonical, { flag: "wx" });
    // A hard link publishes the complete scenario exclusively; rename could overwrite an existing file.
    await link(pending, join(destination, conversionFiles.scenario));
    await unlink(pending);
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  return {
    directory: destination,
    scenario: join(destination, conversionFiles.scenario),
    report: join(destination, conversionFiles.report),
    execution: "not-run" as const,
  };
}
