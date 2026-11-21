import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  runRecoveryServiceParity,
  recoveryServicePlan,
  checkRecoveryServiceObservations,
  checkRecoveryServiceEvidence,
} from "../../scripts/recovery-service-parity.js";
import type {
  RecoveryParityCase,
  RecoveryServiceEvidence,
} from "../../scripts/recovery-service-observations.js";

const fixture = async (name: RecoveryParityCase) => ({
  scenario: await readFile(
    `scenarios/timeline-static-recovery/${name}/scenario.json`,
    "utf8",
  ),
  configuration: await readFile(
    `scenarios/timeline-static-recovery/${name}/runtime.json`,
    "utf8",
  ),
});

test("recovery service transcription preserves full literal duplicate and reconnect expectations", async () => {
  const { scenario, configuration } = await fixture("s1");
  const plan = recoveryServicePlan("s1", scenario, configuration);
  const retry = plan.steps.find((step) => step.id === "retry-original");
  assert.equal(retry?.kind, "publish");
  if (retry?.kind !== "publish") throw new Error("Missing retry");
  const expected = retry.expected as {
    status: string;
    version: number;
    targets: unknown[];
  };
  assert.equal(expected.status, "duplicate");
  assert.equal(expected.version, 1);
  assert.equal(expected.targets.length, 2);
  const reconnect = plan.steps.find((step) => step.id === "resubscribe");
  assert.equal(reconnect?.kind, "subscribe");
  if (reconnect?.kind !== "subscribe") throw new Error("Missing reconnect");
  assert.equal(reconnect.connection, "reconnect-observer");
  assert.equal(reconnect.expected.version, 4);
  assert.deepEqual(reconnect.expected.publicationSequences, {
    arrival: [11],
    history: [10, 11, 12],
    latest: [12],
  });
  const changed = JSON.parse(scenario);
  changed.actions.find((a: { id: string }) => a.id === "stop").mode = "abrupt";
  assert.throws(() =>
    recoveryServicePlan("s1", JSON.stringify(changed), configuration),
  );
  const missing = JSON.parse(scenario);
  missing.assertions = missing.assertions.filter(
    (a: { id: string }) => a.id !== "restored-b",
  );
  assert.throws(
    () => recoveryServicePlan("s1", JSON.stringify(missing), configuration),
    /HTTP checkpoints/,
  );
  assert.throws(() => recoveryServicePlan("m1", scenario, configuration));
  assert.throws(
    () => recoveryServicePlan("s1", scenario, configuration + " "),
    /configuration bytes/,
  );
});

for (const name of ["m1", "s1"] as const) {
  test(
    `ordinary service ${name} proves recovery receipts, snapshots and orderly lifecycle`,
    { timeout: 60000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "recovery-parity-test-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const output = join(directory, "evidence");
      const { scenario, configuration } = await fixture(name);
      const evidence = await runRecoveryServiceParity(
        output,
        name,
        resolve(process.env.ZOOGLASS_SERVICE_DIRECTORY ?? "../zooglass"),
      );
      assert.deepEqual(
        checkRecoveryServiceObservations(
          name,
          scenario,
          configuration,
          evidence,
        ),
        {
          publications: 6,
          checkpoints: name === "m1" ? 10 : 12,
          clientSnapshots: 3,
          generations: 2,
        },
      );
      assert.equal(
        await readFile(join(output, "scenario.json"), "utf8"),
        scenario,
      );
      assert.equal(
        await readFile(join(output, "runtime.json"), "utf8"),
        configuration,
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(output, "evidence.json"), "utf8")),
        evidence,
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(output, "plan.json"), "utf8")),
        recoveryServicePlan(name, scenario, configuration),
      );
      await assert.rejects(runRecoveryServiceParity(output, name), {
        code: "EEXIST",
      });
      assert.throws(() =>
        checkRecoveryServiceEvidence(evidence, scenario, configuration),
      );

      const mutations: [string, (copy: RecoveryServiceEvidence) => void][] = [
        [
          "missing orderly stop",
          (copy) => {
            copy.lifecycle.pop();
          },
        ],
        [
          "forced stop cannot count",
          (copy) => {
            delete copy.lifecycle[1].orderly;
          },
        ],
        [
          "missing barrier",
          (copy) => {
            copy.completedSteps.pop();
          },
        ],
        [
          "stale client reference",
          (copy) => {
            copy.clientChecks[2].connection = "connect-observer";
          },
        ],
        [
          "missing HTTP recovery",
          (copy) => {
            copy.http.splice(
              copy.http.findIndex((h) => h.barrier === "restored-a"),
              1,
            );
          },
        ],
        [
          "altered HTTP snapshot",
          (copy) => {
            const h = copy.http.find((h) => h.barrier === "restored-a")!;
            const snapshot = JSON.parse(h.raw);
            snapshot.version++;
            h.raw = JSON.stringify(snapshot);
          },
        ],
        [
          "wrong duplicate version",
          (copy) => {
            const c = copy.connections.find(
              (c) => c.id === "reconnect-source",
            )!;
            const receipt = JSON.parse(c.received[0]);
            receipt.version = 999;
            c.received[0] = JSON.stringify(receipt);
          },
        ],
        [
          "missing original targets",
          (copy) => {
            const c = copy.connections.find(
              (c) => c.id === "reconnect-source",
            )!;
            const receipt = JSON.parse(c.received[0]);
            receipt.targets = [];
            c.received[0] = JSON.stringify(receipt);
          },
        ],
        [
          "wrong reconnect snapshot",
          (copy) => {
            const ref = copy.clientChecks[2];
            const c = copy.connections.find((c) => c.id === ref.connection)!;
            const frame = JSON.parse(c.received[ref.frame]);
            frame.version++;
            c.received[ref.frame] = JSON.stringify(frame);
          },
        ],
        [
          "altered publication input",
          (copy) => {
            const c = copy.connections.find(
              (c) => c.id === "reconnect-source",
            )!;
            const body = JSON.parse(c.sent[0]);
            body.publicationSequence++;
            c.sent[0] = JSON.stringify(body);
          },
        ],
        [
          "extra source receipt",
          (copy) => {
            const c = copy.connections.find(
              (c) => c.id === "reconnect-source",
            )!;
            c.received.push(c.received[0]);
          },
        ],
      ];
      for (const [label, mutate] of mutations) {
        const changed = structuredClone(evidence);
        mutate(changed);
        assert.throws(
          () =>
            checkRecoveryServiceObservations(
              name,
              scenario,
              configuration,
              changed,
            ),
          Error,
          label,
        );
      }
    },
  );
}
