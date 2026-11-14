import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { action, fixture } from "./document-fixture.js";

export const retirementActor = "sports-retirement";
export const retirement = {
  viewId: "scoreboard",
  entityId: "match-1",
  fields: ["homeScore", "awayScore"],
  minimumBirthSequence: 5,
};
export function retirementAck(
  status = "committed",
  version = 1,
  control = retirement,
) {
  return {
    kind: "factRetirement",
    status,
    reason: null,
    control: { ...control, fields: [...control.fields].sort() },
    version,
    floors: Object.fromEntries(
      control.fields.map((field) => [field, control.minimumBirthSequence]),
    ),
    changedViews: status === "committed" ? [control.viewId] : [],
  };
}
export function retirementAssertion(
  id: string,
  atMs: number,
  expected: unknown[],
) {
  return {
    id,
    atMs,
    kind: "control-receipts",
    actor: retirementActor,
    expected,
  };
}
export function sportsDocument(latencyMs = 3) {
  const base = fixture().document;
  return {
    ...base,
    format: "timeline-simulation/v2",
    id: "bounded-sports-retirement",
    runtime: {
      ...base.runtime,
      storage: "sqlite",
      profile: "sqlite-sports-v1",
    },
    actors: [{ id: retirementActor, role: "retirement" }],
    links: [{ actor: retirementActor, latencyMs }],
    publications: [],
    actions: [
      action("connect", 0, "connect", retirementActor),
      action("retire", 10, "retirement-send", retirementActor, {
        control: retirement,
      }),
    ],
    assertions: [retirementAssertion("ack", 25, [retirementAck()])],
    untilMs: 25,
  };
}
export async function sportsFiles(document = sportsDocument()) {
  const directory = await mkdtemp(join(tmpdir(), "sports-document-"));
  const wire = await readFile(
    new URL(
      "../../../zooglass/simulation-host/src/test/resources/sports-runtime.json",
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
