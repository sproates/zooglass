import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  staticParityPlan,
  runStaticServiceParity,
  checkStaticServiceObservations,
  checkStaticServiceEvidence,
} from "../../scripts/static-service-parity.js";

const fixture = async (name: "late-update" | "mixed-modes") => {
  const directory = resolve("scenarios/timeline-static", name);
  return {
    scenario: await readFile(join(directory, "scenario.json"), "utf8"),
    configuration: await readFile(
      join(
        directory,
        name === "mixed-modes" ? "runtime.json" : "configuration.json",
      ),
      "utf8",
    ),
  };
};

test("static parity preserves the reviewed mixed literals without deriving answers", async () => {
  const { scenario, configuration } = await fixture("mixed-modes");
  const plan = staticParityPlan(scenario, configuration);
  assert.equal(plan.steps.filter((s) => s.kind === "send").length, 5);
  assert.equal(plan.subscriptions.length, 2);
  const late = plan.steps.find((s) => s.id === "data-a-11");
  assert.equal(late?.kind, "check");
  if (late?.kind !== "check") throw new Error("Missing authored checkpoint");
  assert.deepEqual(late.expected, {
    arrival: { temperatureC: 740, sample: "A11" },
    history: [
      { temperatureC: 720, sample: "A10" },
      { temperatureC: 740, sample: "A11" },
      { temperatureC: 760, sample: "A12" },
    ],
    latest: { temperatureC: 760, sample: "A12" },
  });
  assert.deepEqual(
    plan.steps.map((s) => s.id),
    [
      "send-a-10",
      "data-a-10",
      "send-b-10",
      "data-b-10",
      "send-a-12",
      "data-a-12",
      "send-a-11",
      "data-a-11",
      "send-b-11",
      "data-b-11",
    ],
  );
});

test("static parity rejects unsupported lifecycle, dropped acceptance and rounded input", async () => {
  const { scenario, configuration } = await fixture("mixed-modes");
  const changed = (
    mutate: (document: ReturnType<typeof JSON.parse>) => void,
  ) => {
    const document = JSON.parse(scenario);
    mutate(document);
    return () => staticParityPlan(JSON.stringify(document), configuration);
  };
  assert.throws(
    changed((d) =>
      d.actions.push({
        id: "disconnect",
        kind: "disconnect",
        actor: "kiln-observer",
        atMs: 40,
      }),
    ),
    /initial connections\/subscriptions/,
  );
  assert.throws(
    changed(
      (d) =>
        (d.assertions = d.assertions.filter(
          (a: { id: string }) => a.id !== "accepted-a-10",
        )),
    ),
    /Every send/,
  );
  assert.throws(
    changed(
      (d) => (d.publications[0].body.payload.temperatureC = 9007199254740992),
    ),
    /Unsafe parity number/,
  );
  assert.throws(
    changed((d) => {
      d.actions.find((a: { id: string }) => a.id === "send-b-10").atMs = 10;
      d.assertions.find((a: { id: string }) => a.id === "accepted-b-10").atMs =
        10;
    }),
    /sole send at the same timestamp/,
  );
  assert.throws(
    () => staticParityPlan(scenario, configuration + "\n"),
    /Exact configuration bytes/,
  );
});

for (const [name, publications, checkpoints, clientCheckpoints] of [
  ["late-update", 4, 2, 0],
  ["mixed-modes", 5, 5, 5],
] as const) {
  test(`ordinary static parity retains complete ${name} observations and rejects tampering`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "static-parity-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const output = join(directory, "evidence");
    const evidence = await runStaticServiceParity(
      output,
      name,
      resolve("../zooglass"),
    );
    const { scenario, configuration } = await fixture(name);
    assert.equal(evidence.passed, true);
    assert.equal(evidence.complete, true);
    assert.deepEqual(
      checkStaticServiceObservations(scenario, configuration, evidence),
      { publications, checkpoints, clientCheckpoints },
    );
    assert.throws(
      () => checkStaticServiceEvidence(evidence, scenario, configuration),
      "Smoke evidence cannot claim qualification",
    );
    // Exercise the offline metadata policy; this does not qualify the smoke run.
    const qualifiedMetadata = {
      ...evidence,
      qualification: true,
      sourceDirty: false,
    };
    assert.deepEqual(
      checkStaticServiceEvidence(qualifiedMetadata, scenario, configuration),
      { publications, checkpoints, clientCheckpoints },
    );
    for (const field of ["complete", "passed"] as const)
      assert.throws(() =>
        checkStaticServiceEvidence(
          { ...qualifiedMetadata, [field]: false },
          scenario,
          configuration,
        ),
      );
    assert.throws(() =>
      checkStaticServiceEvidence(
        { ...qualifiedMetadata, sourceDirty: true },
        scenario,
        configuration,
      ),
    );
    assert.throws(() =>
      checkStaticServiceEvidence(
        {
          ...qualifiedMetadata,
          provenanceAfter: {
            ...evidence.provenanceAfter,
            service: "0".repeat(64),
          },
        },
        scenario,
        configuration,
      ),
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(output, "evidence.json"), "utf8")),
      evidence,
    );
    assert.ok(
      evidence.http.every(
        (observation) =>
          Object.hasOwn(JSON.parse(observation.raw), "status") &&
          Object.hasOwn(JSON.parse(observation.raw), "publicationSequences"),
      ),
      "Full public snapshots retained",
    );
    const mutate = (change: (copy: typeof evidence) => void) => {
      const copy = structuredClone(evidence);
      change(copy);
      return () =>
        checkStaticServiceObservations(scenario, configuration, copy);
    };
    assert.throws(mutate((copy) => copy.http.pop()));
    assert.throws(
      mutate((copy) => {
        const raw = JSON.parse(copy.http[0].raw);
        raw.data = {};
        copy.http[0].raw = JSON.stringify(raw);
      }),
      /retained HTTP data/,
    );
    assert.throws(
      mutate((copy) => {
        const source = copy.connections.find((c) => c.endpoint === "/events")!;
        const raw = JSON.parse(source.received[0]);
        raw.publicationSequence++;
        source.received[0] = JSON.stringify(raw);
        copy.accepted[0].receipt = raw;
      }),
      /Receipt sequence/,
    );
    assert.throws(
      mutate((copy) => {
        const source = copy.connections.find((c) => c.endpoint === "/events")!;
        const raw = JSON.parse(source.received[0]);
        raw.status = "rejected";
        source.received[0] = JSON.stringify(raw);
        copy.accepted[0].receipt = raw;
      }),
      /Receipt acceptance/,
    );
    if (clientCheckpoints)
      assert.throws(mutate((copy) => (copy.clientChecks[0].frame = 0)));
    await assert.rejects(
      runStaticServiceParity(output, name, resolve("../zooglass")),
      /EEXIST/,
    );
  });
}
