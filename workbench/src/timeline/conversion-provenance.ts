import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { TimelineDocument } from "./contract.js";
import {
  conversionFiles,
  conversionReport,
  conversionReportFormat,
  conversionVersion,
} from "./conversion-document.js";
import { conversionInput } from "./conversion-eligibility.js";
import { evidenceV3 } from "./evidence-versions.js";
import { boundedFile, decode } from "./file-input.js";
import { encodeJson, parseJson } from "./json.js";
import { integer, object, text } from "./validation.js";

/** Exact UTF-8 input bytes, embedded in saved runs so replay never resolves original paths. */
export type ConversionProvenance = { report: string; legacy: string };

function reportHeader(provenance: ConversionProvenance) {
  if (
    !provenance ||
    typeof provenance !== "object" ||
    Array.isArray(provenance) ||
    Object.keys(provenance).sort().join(",") !== "legacy,report" ||
    typeof provenance.report !== "string" ||
    typeof provenance.legacy !== "string"
  )
    throw new Error(
      "invalid-conversion-provenance: expected exact report and legacy strings",
    );
  const report = object(parseJson(provenance.report), "conversion report");
  if (report.format !== conversionReportFormat)
    throw new Error("invalid-conversion-provenance: unsupported report format");
  const converter = object(report.converter, "conversion report.converter", [
    "version",
    "workbenchSha256",
    "artifactSha256",
  ]);
  if (converter.version !== conversionVersion)
    throw new Error(
      "invalid-conversion-provenance: unsupported converter version",
    );
  for (const key of ["workbenchSha256", "artifactSha256"])
    if (
      !/^[a-f0-9]{64}$/.test(
        text(converter[key], `conversion report.converter.${key}`),
      )
    )
      throw new Error(
        "invalid-conversion-provenance: invalid recorded converter identity",
      );
  return { report, converter };
}

/** Pure verification of hashes AND deterministic transcription; no host or outcome computation. */
export function validateConversionProvenance(
  scenario: TimelineDocument,
  configuration: string,
  provenance?: ConversionProvenance,
): ConversionProvenance | undefined {
  const declared = scenario.document.conversionReport;
  if (declared === undefined) {
    if (provenance !== undefined)
      throw new Error(
        "invalid-conversion-provenance: undeclared conversion report",
      );
    return undefined;
  }
  if (scenario.format !== evidenceV3.scenario || provenance === undefined)
    throw new Error(
      "invalid-conversion-provenance: declared conversion report is missing or not V3",
    );
  text(declared, "conversionReport");
  const { report, converter } = reportHeader(provenance);
  const options = object(report.options, "conversion report.options", [
    "epochMillis",
    "seed",
  ]);
  const rebuilt = conversionReport(
    provenance.legacy,
    configuration,
    {
      epochMillis: integer(
        options.epochMillis,
        "conversion report.options.epochMillis",
      ),
      seed: text(options.seed, "conversion report.options.seed"),
    },
    {
      workbenchSha256: text(
        converter.workbenchSha256,
        "converter.workbenchSha256",
      ),
      artifactSha256: text(
        converter.artifactSha256,
        "converter.artifactSha256",
      ),
    },
  );
  if (rebuilt.canonical !== scenario.canonical)
    throw new Error(
      "invalid-conversion-provenance: converted document differs from original legacy transcription",
    );
  if (encodeJson(report) !== rebuilt.report)
    throw new Error(
      "invalid-conversion-provenance: report hashes, expectations, mappings or adaptations differ from regenerated claims",
    );
  return provenance;
}

/** Reconstruct the reference for fresh production-normalized comparison before runtime startup. */
export function conversionReferenceConfiguration(
  provenance: ConversionProvenance,
): string {
  const { report } = reportHeader(provenance);
  const reference = conversionInput(provenance.legacy).referenceConfiguration;
  if (report.referenceConfiguration !== reference)
    throw new Error(
      "invalid-conversion-provenance: compiler reference differs from original legacy declarations",
    );
  return reference;
}

async function member(directory: string, name: string) {
  if (
    isAbsolute(name) ||
    name.includes("\\") ||
    name.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(
      "invalid-conversion-provenance: expected contained relative report path",
    );
  const file = resolve(directory, name);
  if (!(await lstat(file)).isFile())
    throw new Error(
      "invalid-conversion-provenance: expected regular provenance file",
    );
  const base = await realpath(directory);
  const resolved = await realpath(file);
  const difference = relative(base, resolved);
  if (
    !difference ||
    isAbsolute(difference) ||
    difference === ".." ||
    difference.startsWith(`..${sep}`)
  )
    throw new Error(
      "invalid-conversion-provenance: provenance path escapes scenario directory",
    );
  return { file, contents: decode(await boundedFile(file)) };
}

/** Load declared provenance before execution; missing files are errors, not an optional fallback. */
export async function loadConversionProvenance(
  scenarioPath: string,
  scenario: TimelineDocument,
  configuration: string,
): Promise<ConversionProvenance | undefined> {
  if (scenario.document.conversionReport === undefined) return undefined;
  const report = await member(
    dirname(resolve(scenarioPath)),
    text(scenario.document.conversionReport, "conversionReport"),
  );
  const legacy = await member(dirname(report.file), conversionFiles.legacy);
  return validateConversionProvenance(scenario, configuration, {
    report: report.contents,
    legacy: legacy.contents,
  });
}

/** Bundle membership is fixed; report-provided paths are never interpreted by bundle readers. */
export function conversionBundleFiles(
  provenance: ConversionProvenance,
): Record<string, string> {
  return {
    [conversionFiles.report]: provenance.report,
    [conversionFiles.legacy]: provenance.legacy,
  };
}
