import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { action, fixture } from "./document-fixture.js";

export const controlActor = "order-progress";
export const control = {
  sourceId: "orders",
  epoch: "run",
  sourceEntityId: "order-1",
  throughSequence: 3,
};
export function watermark(duplicate = false) {
  return {
    kind: "watermark",
    status: duplicate ? "duplicate" : "committed",
    reason: duplicate ? "alreadyCommitted" : "sqlite",
    stream: { sourceId: "orders", epoch: "run", sourceEntityId: "order-1" },
    throughSequence: 3,
    version: 1,
    changedViews: duplicate ? [] : ["order-summary", "order-tracking"],
  };
}
export const invalidWatermark = {
  kind: "watermark",
  status: "rejected",
  reason: "invalidProgress",
  stream: null,
  throughSequence: null,
  version: null,
  changedViews: [],
};
export function controlAssertion(
  id: string,
  atMs: number,
  expected: unknown[],
) {
  return { id, atMs, kind: "control-receipts", actor: controlActor, expected };
}
export function orderDocument(latencyMs = 3) {
  const base = fixture().document;
  return {
    ...base,
    format: "timeline-simulation/v2",
    id: "bounded-order-controls",
    runtime: { ...base.runtime, storage: "sqlite", profile: "sqlite-order-v1" },
    actors: [{ id: controlActor, role: "progress" }],
    links: [{ actor: controlActor, latencyMs }],
    publications: [],
    actions: [
      action("connect", 0, "connect", controlActor),
      action("watermark", 10, "progress-send", controlActor, { control }),
    ],
    assertions: [controlAssertion("control-ack", 25, [watermark()])],
    untilMs: 25,
  };
}
/** Exact accepted configuration, exported to an isolated directory for tests and CLI smoke. */
export async function orderFiles(document = orderDocument()) {
  const directory = await mkdtemp(join(tmpdir(), "order-document-"));
  const wire = await readFile(
    new URL(
      "../../../zooglass/simulation-host/src/test/resources/order-runtime.json",
      import.meta.url,
    ),
    "utf8",
  );
  document.runtime.sha256 = createHash("sha256").update(wire).digest("hex");
  const path = join(directory, "scenario.json");
  await writeFile(join(directory, "runtime.json"), wire);
  await writeFile(path, JSON.stringify(document));
  return {
    directory,
    path,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
