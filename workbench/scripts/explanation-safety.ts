import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { readBundle } from "../src/timeline/artifact-bundle.js";
import { Decimal, encodeJson, parseJson } from "../src/timeline/json.js";
import { object } from "../src/timeline/validation.js";
import { explainBundle, writeExplanation } from "../src/explanation/reader.js";
import { explanationModel, reportLimits } from "../src/explanation/model.js";
import { renderExplanation } from "../src/explanation/render.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type SafetyCheck = { name: string; expected: string; passed: true };

/** Recompute both retained trace copies and inventory: semantic validation must find the defect. */
async function inconsistentBundle(
  original: Awaited<ReturnType<typeof readBundle>>,
  directory: string,
  duplicate: boolean,
) {
  const records = original.trace.lines.map((line) =>
    object(parseJson(line), "record"),
  );
  const referred = new Set(
    records.flatMap((record) => [
      record.parentId,
      ...(Array.isArray(record.causes) ? record.causes : []),
    ]),
  );
  const index = records.findIndex(
    (record) =>
      record.kind === "publication-decision" && !referred.has(record.eventId),
  );
  assert.ok(
    index > 0,
    "safety audit requires an unreferenced publication decision",
  );
  if (duplicate) {
    let id = "safety-duplicate-decision";
    while (records.some((record) => record.eventId === id)) id += "-copy";
    records.splice(index + 1, 0, { ...records[index], eventId: id });
  } else records.splice(index, 1);
  records.at(-1)!.eventCount = new Decimal(String(records.length - 2));
  const trace = records.map((record) => encodeJson(record) + "\n").join("");
  const run = encodeJson({ ...original.saved, trace }) + "\n";
  const manifest = object(
    parseJson(await readFile(join(directory, "manifest.json"), "utf8")),
    "manifest",
  );
  const files = object(manifest.files, "files");
  for (const [name, bytes] of [
    ["trace.jsonl", trace],
    ["run.json", run],
  ]) {
    await writeFile(join(directory, name), bytes);
    files[name] = {
      bytes: new Decimal(String(Buffer.byteLength(bytes))),
      sha256: hash(bytes),
    };
  }
  await writeFile(
    join(directory, "manifest.json"),
    encodeJson(manifest) + "\n",
  );
}

/** Offline negative controls on disposable copies; each must fail for its intended reason. */
export async function auditExplanationSafety(bundle: string, scratch: string) {
  const original = await readBundle(bundle);
  assert.equal(
    original.versions.trace,
    "timeline-trace/v5",
    "safety audit requires V5 evidence",
  );
  assert.ok(
    original.trace.publicationDecisions.length > 0,
    "safety audit requires recorded publication decisions",
  );
  const source = await realpath(bundle);
  const destination = resolve(
    await realpath(dirname(resolve(scratch))),
    basename(resolve(scratch)),
  );
  const path = relative(source, destination);
  assert.ok(
    path && (isAbsolute(path) || path === ".." || path.startsWith(".." + sep)),
    "safety scratch must be outside the original bundle",
  );
  // Exclusive creation: cleanup must never own a caller's pre-existing directory.
  await mkdir(destination);
  const checks: SafetyCheck[] = [];
  const rejected = async (
    name: string,
    work: () => unknown | Promise<unknown>,
    expected: RegExp,
  ) => {
    await assert.rejects(
      async () => {
        await work();
      },
      expected,
      name,
    );
    checks.push({ name, expected: expected.source, passed: true });
  };
  try {
    const copy = async (name: string) => {
      const directory = join(destination, name);
      await cp(source, directory, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      return directory;
    };
    const corrupted = await copy("corrupt-hash");
    await writeFile(
      join(corrupted, "trace.jsonl"),
      original.trace.canonical + " ",
    );
    await rejected(
      "corrupted-trace-hash",
      () => explainBundle(corrupted),
      /trace\.jsonl hash\/size mismatch/,
    );
    for (const duplicate of [false, true]) {
      const directory = await copy(
        duplicate ? "duplicate-decision" : "missing-decision",
      );
      await inconsistentBundle(original, directory, duplicate);
      await rejected(
        duplicate
          ? "recomputed-duplicate-decision"
          : "recomputed-missing-decision",
        () => explainBundle(directory),
        duplicate
          ? /decision requires exactly one preceding receipt/
          : /missing publication decision for receipt/,
      );
    }
    const retained = await copy("unchanged");
    await rejected(
      "output-inside-evidence",
      () => writeExplanation(retained, join(retained, "report.json"), "json"),
      /must be outside the evidence directory/,
    );
    const alias = join(destination, "evidence-alias");
    await symlink(retained, alias);
    await rejected(
      "output-through-symlink-parent",
      () => writeExplanation(retained, join(alias, "report.json"), "json"),
      /must be outside the evidence directory/,
    );
    const existing = join(destination, "existing-report.json");
    await writeFile(existing, "existing bytes\n", { flag: "wx" });
    await rejected(
      "existing-output",
      () => writeExplanation(retained, existing, "json"),
      /EEXIST/,
    );
    assert.equal(await readFile(existing, "utf8"), "existing bytes\n");
    let unknown = "safety-unknown-event";
    while (original.trace.events.some((event) => event.id === unknown))
      unknown += "-missing";
    await rejected(
      "unknown-event",
      () =>
        writeExplanation(
          retained,
          join(destination, "unknown.json"),
          "json",
          unknown,
        ),
      /Unknown event ID:/,
    );
    await rejected(
      "entry-limit",
      () =>
        explanationModel({
          profile: original.scenario.profile,
          outcome: original.outcome,
          format: original.trace.header.format,
          evidence: original.evidence,
          events: Array(reportLimits.entries + 1).fill(
            original.trace.events[0],
          ),
          publicationDecisions: original.trace.publicationDecisions,
        }),
      /Explanation report entry limit exceeded/,
    );
    const report = await explainBundle(retained);
    const oversized = { ...report, notes: [...report.notes] };
    oversized.notes.push("x".repeat(reportLimits.bytes));
    for (const format of ["text", "json"] as const)
      await rejected(
        `${format}-byte-limit`,
        () => renderExplanation(oversized, format),
        /Explanation report byte limit exceeded/,
      );
    report.entries[0].actor = "id\u001b[31m\n\u202e";
    const escaped = renderExplanation(report, "text");
    assert.ok(escaped.includes("id\\u001b[31m\\u000a\\u202e"));
    assert.ok(!escaped.includes("\u001b") && !escaped.includes("\u202e"));
    checks.push({
      name: "terminal-control-escaping",
      expected: "control characters rendered as literal Unicode escapes",
      passed: true,
    });
    assert.deepEqual(
      (await readBundle(retained)).evidence,
      original.evidence,
      "output checks preserve their evidence copy",
    );
    assert.deepEqual(
      (await readBundle(source)).evidence,
      original.evidence,
      "original evidence unchanged",
    );
    return {
      format: "timeline-explanation-safety/v1",
      input: original.evidence,
      checks,
    };
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}
