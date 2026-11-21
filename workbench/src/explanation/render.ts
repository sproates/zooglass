import { reportLimits, type ExplanationReport } from "./model.js";

/** Escape terminal controls, including bidirectional overrides, without altering evidence. */
export function terminalText(value: string): string {
  return value.replace(
    // eslint-disable-next-line no-control-regex -- Match unsafe terminal controls to escape them.
    /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
function bounded(parts: Iterable<string>): string {
  const output: string[] = [];
  let size = 0;
  for (const part of parts) {
    size += Buffer.byteLength(part);
    if (size > reportLimits.bytes)
      throw new Error("Explanation report byte limit exceeded");
    output.push(part);
  }
  return output.join("");
}
function* jsonParts(report: ExplanationReport) {
  const { entries, ...metadata } = report;
  yield JSON.stringify(metadata).slice(0, -1) + ',"entries":[';
  for (const [index, entry] of entries.entries())
    yield (index ? "," : "") + JSON.stringify(entry);
  yield "]}\n";
}
function* textParts(report: ExplanationReport) {
  const line = (value: string) => terminalText(value) + "\n";
  yield "Timeline explanation\n";
  yield line(`Recorded profile: ${report.recordedProfile}`);
  yield line(
    `Recorded outcome: ${report.recordedOutcome}; replay: ${report.replayStatus}`,
  );
  yield line(`Manifest SHA-256: ${report.input.manifestSha256}`);
  yield line(`Trace SHA-256: ${report.input.traceSha256}`);
  yield line(report.coverage.note);
  for (const note of report.notes) yield line(note);
  for (const entry of report.entries) {
    yield "\n";
    yield line(
      `${entry.eventId} | ${entry.timeMs} ms | ${entry.kind} | ${entry.actor} | runtime ${entry.runtimeGeneration ?? "unavailable"}, connection ${entry.connectionGeneration ?? "none"}`,
    );
    yield line(
      `Parent: ${entry.parentId ?? "none"}; causes: ${entry.causes.join(", ") || "none"}`,
    );
    if ("decision" in entry) {
      const decision = entry.decision;
      yield line(decision.explanation);
      yield line(
        `Attempt: ${decision.attemptEventId}; receipt: ${decision.receiptEventId}`,
      );
      if (decision.availability === "unavailable") {
        yield line(`Detail unavailable: ${decision.reason}`);
        continue;
      }
      yield line(`Publication: ${JSON.stringify(decision.publication)}`);
      yield line(
        `Outcome: ${decision.status}/${decision.reason}; version: ${decision.version ?? "none"}; installed: ${decision.installed}`,
      );
      if (decision.originalDetail)
        yield line(
          `Original detail: ${decision.originalDecisionEventId ?? "unavailable"}`,
        );
      for (const target of decision.targets) {
        yield line(`Target: ${target.viewId}/${target.entityId ?? "unmapped"}`);
        for (const field of target.fields)
          yield line(
            `  ${field.field} (${field.strategy}): ${field.update}; retained changed: ${field.retainedChanged}; public changed: ${field.publicChanged}. ${field.explanation}`,
          );
      }
    } else {
      yield line(entry.explanation);
      if ("status" in entry) {
        yield line(`Publication: ${JSON.stringify(entry.publication)}`);
        yield line(
          `Outcome: ${entry.status}/${entry.reason}; version: ${entry.version ?? "none"}`,
        );
      }
      if ("passed" in entry)
        yield line(`Assertion: ${entry.assertionId}; passed: ${entry.passed}`);
      if ("actionKind" in entry)
        yield line(`Action: ${entry.actionId} (${entry.actionKind})`);
    }
  }
}
export function renderExplanation(
  report: ExplanationReport,
  format: "text" | "json",
) {
  if (format !== "text" && format !== "json")
    throw new Error("Unsupported explanation format");
  return bounded(format === "json" ? jsonParts(report) : textParts(report));
}
