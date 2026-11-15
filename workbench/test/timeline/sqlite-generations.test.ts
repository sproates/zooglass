import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Bridge, type Response } from "../../src/timeline/bridge.js";
import { RuntimeGenerations } from "../../src/timeline/runtime-generations.js";
import { epoch, fixture, frame, receipt } from "./document-fixture.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
const config = fixture().configuration;
config.storage = "sqlite";
config.views[0].fields.reading.freshness.staleAfterMillis = 30;
const configuration = JSON.stringify(config);
const publication = JSON.stringify(fixture().document.publications[0].body);
const targets = [{ viewId: "stock-view", entityId: "sku-4" }];
const persistedReceipt = (duplicate = false) => ({
  ...receipt(1, 1, duplicate),
  status: duplicate ? "duplicate" : "committed",
  reason: duplicate ? "alreadyCommitted" : "sqlite",
});
function installed(
  version = 0,
  freshness = "absent",
  receivedAt: number | null = null,
) {
  const expected = frame(version, version ? 1 : 0, freshness, receivedAt);
  const { type, publicationSequences, ...snapshot } = expected;
  void type;
  void publicationSequences;
  return {
    ...snapshot,
    data: version
      ? { reading: { publicationSequence: 1, payload: { amount: 1 } } }
      : {},
  };
}
function snapshots(response: Response) {
  assert.ok(
    response.snapshots,
    "initialization includes requested installed snapshots",
  );
  return response.snapshots.map((wire) => JSON.parse(wire));
}
function received(response: Response) {
  const effect = response.effects.find((item) => item.kind === "receipt");
  assert.ok(effect?.kind === "receipt");
  return JSON.parse(effect.wire);
}
async function publish(owner: RuntimeGenerations, time = 10) {
  await owner.command(owner.current!, time, {
    op: "connect",
    session: "source",
    role: "source",
  });
  return owner.command(owner.current!, time, {
    op: "ingress",
    session: "source",
    wire: publication,
  });
}

for (const mode of ["orderly", "abrupt"] as const) {
  for (const restart of [25, 40, 50]) {
    test(`${mode} SQLite restart at ${restart} installs literal recovery before any ordinary command`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "timeline-sqlite-"));
      const database = join(directory, "runtime.db");
      const owner = new RuntimeGenerations({
        jar,
        configuration,
        database,
        observationTargets: targets,
        epochMillis: epoch,
        commandLimit: 100,
        hostDelay: restart === 50 ? 70 : 0,
        jvmPauseMs: restart === 50 ? 90 : 0,
      });
      try {
        const initial = await owner.start(0);
        assert.deepEqual(snapshots(initial), [installed()]);
        assert.deepEqual(initial.effects, []);
        assert.deepEqual(received(await publish(owner)), persistedReceipt());
        const retired = owner.current!;
        await owner.stop(retired, 11, mode);
        assert.ok(
          (await stat(database)).size > 0,
          "store survives stopped host",
        );
        const recovered = await owner.start(restart);
        const stale = restart >= 40;
        assert.equal(recovered.monotonicMs, 0);
        assert.equal(recovered.wallMillis, epoch + restart);
        assert.deepEqual(snapshots(recovered), [
          installed(stale ? 2 : 1, stale ? "stale" : "fresh", epoch + 10),
        ]);
        assert.ok(
          !recovered.effects.some((effect) => effect.kind === "state"),
          "recovery is not a retroactive state callback",
        );
        const tasks = recovered.effects.filter(
          (effect) => effect.kind === "schedule",
        );
        assert.equal(tasks.length, stale ? 0 : 1);
        if (tasks.length)
          assert.equal(
            tasks[0].at,
            40,
            "recovered remaining age uses global deadline",
          );
        await assert.rejects(
          owner.command(retired, restart, { op: "observe" }),
          /Stale runtime/,
        );
        const duplicate = await publish(owner, restart);
        assert.deepEqual(received(duplicate), persistedReceipt(true));
        assert.ok(
          !duplicate.effects.some(
            (effect) => effect.kind === "state" || effect.kind === "schedule",
          ),
          "duplicate cannot refresh receipt age or version",
        );
        if (!stale) {
          const alarm = tasks[0];
          const expired = await owner.command(owner.current!, 40, {
            op: "task",
            task: alarm.task,
          });
          const state = expired.effects.find(
            (effect) => effect.kind === "state",
          );
          assert.ok(state?.kind === "state");
          assert.deepEqual(
            JSON.parse(state.wire),
            installed(2, "stale", epoch + 10),
          );
        }
        await owner.stop(owner.current!, Math.max(restart, 40), "orderly");
      } finally {
        await owner.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}

test("SQLite metadata admission has native identity without a configured writable database", async () => {
  const metadata = await Bridge.open(jar);
  try {
    assert.equal(
      metadata.bridge.environment?.sqliteVersion,
      undefined,
      "v1 identity stays unchanged",
    );
    const inspected = await metadata.bridge.command(0, {
      op: "inspect-configuration",
      wire: configuration,
    });
    assert.deepEqual(inspected.configuration, {
      contractVersion: 2,
      storage: "sqlite",
      documentProfile: "receipt-age-restart-v1",
    });
    assert.deepEqual(inspected.effects, []);
    assert.equal(inspected.pendingTasks, 0);
  } finally {
    await metadata.bridge.close();
  }
  const lifecycle = await Bridge.open(jar, 0, 0, {
    runtimeGeneration: 1,
    startTimeMs: 0,
    firstTurnId: 0,
  });
  try {
    assert.equal(lifecycle.bridge.sqliteLifecycle, 1);
    assert.match(lifecycle.bridge.environment!.sqliteVersion, /^\d+\.\d+\.\d+/);
  } finally {
    await lifecycle.bridge.close();
  }
});

test("failed SQLite startup is terminal and leaves diagnostic database bytes intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timeline-invalid-db-"));
  const database = join(directory, "runtime.db");
  await writeFile(database, "deliberately invalid database");
  const owner = new RuntimeGenerations({
    jar,
    configuration,
    database,
    observationTargets: targets,
    epochMillis: epoch,
    commandLimit: 20,
  });
  try {
    await assert.rejects(owner.start(0), /Runtime exited/);
    assert.equal(owner.current, undefined);
    await assert.rejects(owner.start(0), /Runtime exited/);
    assert.ok((await stat(database)).size > 0);
  } finally {
    await owner.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid initialization targets and paths reject before opening a store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timeline-admission-"));
  const database = join(directory, "must-not-exist.db");
  try {
    for (const fields of [
      {
        database,
        observationTargets: [{ viewId: "missing", entityId: "sku-4" }],
      },
      { database, observationTargets: [targets[0], targets[0]] },
      { database: "relative.db", observationTargets: targets },
      { observationTargets: targets },
      {
        database,
        wire: JSON.stringify(fixture().configuration),
        observationTargets: targets,
      },
    ]) {
      const { bridge } = await Bridge.open(jar, 0, 0, {
        runtimeGeneration: 1,
        startTimeMs: 0,
        firstTurnId: 0,
      });
      try {
        await assert.rejects(
          bridge.command(0, {
            op: "initialize-document",
            wire: configuration,
            epochMillis: epoch,
            ...fields,
          }),
          /Runtime exited/,
        );
        await assert.rejects(stat(database), { code: "ENOENT" });
      } finally {
        await bridge.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("initialization targets preserve request order and are copied at owner construction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timeline-target-order-"));
  const mutableTargets = [
    { viewId: "stock-view", entityId: "second" },
    { viewId: "stock-view", entityId: "first" },
  ];
  const owner = new RuntimeGenerations({
    jar,
    configuration,
    database: join(directory, "runtime.db"),
    observationTargets: mutableTargets,
    epochMillis: epoch,
    commandLimit: 20,
  });
  mutableTargets[0].entityId = "mutated";
  mutableTargets.reverse();
  try {
    const installed = snapshots(await owner.start(0));
    assert.deepEqual(
      installed.map((value) => value.entityId),
      ["second", "first"],
    );
    assert.ok(installed.every((value) => value.version === 0));
    await owner.stop(owner.current!, 0, "orderly");
  } finally {
    await owner.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("expected native environment is enforced without an expected artifact and copied before startup", async () => {
  const opened = await Bridge.open(jar, 0, 0, {
    runtimeGeneration: 1,
    startTimeMs: 0,
    firstTurnId: 0,
  });
  const expected: Record<string, string> = {
    ...opened.bridge.environment!,
    sqliteVersion: "incorrect",
  };
  await opened.bridge.close();
  const directory = await mkdtemp(join(tmpdir(), "timeline-environment-"));
  const database = join(directory, "must-not-exist.db");
  const owner = new RuntimeGenerations({
    jar,
    configuration,
    database,
    expectedEnvironment: expected,
    epochMillis: epoch,
    commandLimit: 20,
  });
  delete expected.sqliteVersion;
  try {
    await assert.rejects(owner.start(0), /environment changed/);
    await assert.rejects(stat(database), { code: "ENOENT" });
  } finally {
    await owner.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("direct bridge copies observation targets before an asynchronous host pause", async () => {
  const opened = await Bridge.open(jar, 70, 0, {
    runtimeGeneration: 1,
    startTimeMs: 0,
    firstTurnId: 0,
  });
  const mutable = [{ viewId: "stock-view", entityId: "original" }];
  try {
    const pending = opened.bridge.command(0, {
      op: "initialize-document",
      wire: JSON.stringify(fixture().configuration),
      epochMillis: epoch,
      observationTargets: mutable,
    });
    mutable[0].entityId = "changed";
    mutable.push({ viewId: "stock-view", entityId: "extra" });
    const result = snapshots(await pending);
    assert.deepEqual(
      result.map((value) => value.entityId),
      ["original"],
    );
  } finally {
    await opened.bridge.close();
  }
});
