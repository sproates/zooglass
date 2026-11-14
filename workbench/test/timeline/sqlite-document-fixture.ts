import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  action,
  epoch,
  fixture,
  frame,
  receipt,
  source,
} from "./document-fixture.js";

export const target = { viewId: "stock-view", entityId: "sku-4" };
export function installed(version = 0, freshness = "absent") {
  const { type, publicationSequences, ...snapshot } = frame(
    version,
    version ? 1 : 0,
    freshness,
    version ? epoch + 10 : null,
  );
  void type;
  void publicationSequences;
  return {
    ...snapshot,
    data: version
      ? { reading: { publicationSequence: 1, payload: { amount: 1 } } }
      : {},
  };
}
export function durableReceipt(duplicate = false) {
  return {
    ...receipt(1, 1, duplicate),
    status: duplicate ? "duplicate" : "committed",
    reason: duplicate ? "alreadyCommitted" : "sqlite",
  };
}
export function observation(id: string, atMs: number, expected: unknown) {
  return { id, atMs, kind: "runtime-snapshot", ...target, expected };
}
export function sqliteInput(restart = 50, mode = "abrupt") {
  const base = fixture();
  base.configuration.storage = "sqlite";
  base.configuration.views[0].fields.reading.freshness.staleAfterMillis = 30;
  const until = Math.max(40, restart);
  const document: Record<string, unknown> = {
    ...base.document,
    format: "timeline-simulation/v2",
    id: `sqlite-restart-${mode}-${restart}`,
    runtime: { ...base.document.runtime, storage: "sqlite" },
    observationTargets: [target],
    actions: [
      action("connect", 0, "connect", source),
      action("send", 10, "source-send", source, { publication: "report-1" }),
      { id: "stop", atMs: 11, kind: "service-stop", mode },
      { id: "start", atMs: restart, kind: "service-start" },
      action("reconnect", restart, "connect", source),
      action("retry", restart, "source-retry", source, {
        publication: "report-1",
      }),
    ],
    assertions: [
      observation("initial", 0, {
        outcome: "available",
        snapshot: installed(),
      }),
      observation("unavailable", 15, { outcome: "runtime-unavailable" }),
      observation("recovered", restart, {
        outcome: "available",
        snapshot: installed(
          restart >= 40 ? 2 : 1,
          restart >= 40 ? "stale" : "fresh",
        ),
      }),
      observation("expired", until, {
        outcome: "available",
        snapshot: installed(2, "stale"),
      }),
      {
        id: "original-receipt",
        atMs: until,
        kind: "source-receipts",
        actor: source,
        expected: [durableReceipt(), durableReceipt(true)],
      },
    ],
    untilMs: until,
  };
  return { document, configuration: base.configuration };
}
export async function sqliteFiles(input = sqliteInput()) {
  const directory = await mkdtemp(join(tmpdir(), "sqlite-document-"));
  const wire = JSON.stringify(input.configuration);
  const runtime = input.document.runtime as Record<string, unknown>;
  runtime.sha256 = createHash("sha256").update(wire).digest("hex");
  const path = join(directory, "scenario.json");
  await writeFile(join(directory, "runtime.json"), wire);
  await writeFile(path, JSON.stringify(input.document));
  return {
    directory,
    path,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
