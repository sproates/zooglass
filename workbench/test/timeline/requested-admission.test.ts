import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  inspectRequestedConfiguration,
  inspectStaticConfiguration,
} from "../../src/timeline/requested-admission.js";
import { Bridge } from "../../src/timeline/bridge.js";
import {
  decodeHandshake,
  decodeResponse,
  type Response,
} from "../../src/timeline/host-protocol.js";
import {
  evidenceV3,
  staticViewsProfile,
  documentEvidenceVersions,
} from "../../src/timeline/evidence-versions.js";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import { fixture } from "./document-fixture.js";

const jar = resolve(
  process.env.ZOOGLASS_SIMULATION_JAR ??
    "../zooglass/simulation-host/target/zooglass-simulation.jar",
);
const fleet = resolve("scenarios/timeline-fleet/runtime.json");
const response: Response = {
  turnId: 0,
  runtimeGeneration: 1,
  timeMs: 0,
  effects: [],
  pendingTasks: 0,
  heldFrames: 0,
  configuration: {
    contractVersion: 2,
    storage: "memory",
    documentProfile: "memory-sequence-fleet-v1",
  },
  requestedProfile: { profile: staticViewsProfile, eligible: true, issues: [] },
};

test("requested admission negotiates capability and rejects runtime work or mismatched results", async () => {
  let commands = 0;
  let result = response;
  const bridge = {
    memoryStaticViews: 0 as 0 | 1,
    command: async () => {
      commands++;
      return result;
    },
  };
  await assert.rejects(
    inspectRequestedConfiguration(bridge, "{}"),
    /no static-view admission capability/,
  );
  assert.equal(commands, 0);
  bridge.memoryStaticViews = 1;
  for (const change of [
    { effects: [{ kind: "state", wire: "{}" }] },
    { pendingTasks: 1 },
    { heldFrames: 1 },
    { snapshots: [] },
    { configuration: undefined },
    { requestedProfile: undefined },
    { requestedProfile: { ...response.requestedProfile, profile: "wrong" } },
    {
      requestedProfile: {
        ...response.requestedProfile,
        comparison: { equivalent: true, differences: [] },
      },
    },
  ]) {
    result = { ...response, ...change } as Response;
    await assert.rejects(
      inspectRequestedConfiguration(bridge, "{}"),
      /mismatched result/,
    );
  }
  result = response;
  await assert.rejects(
    inspectRequestedConfiguration(bridge, "{}", "{}"),
    /mismatched result/,
  );
});

test("protocol checks static capability and coherent eligibility/comparison diagnostics", () => {
  const handshake = {
    protocol: 1,
    fixture: "timeline-proof-v1",
    artifact: "a".repeat(64),
    frameCap: 1024,
    storage: ["memory"],
    protectedAccess: false,
  };
  assert.doesNotThrow(() => decodeHandshake(handshake));
  assert.doesNotThrow(() =>
    decodeHandshake({ ...handshake, memoryStaticViews: 1 }),
  );
  for (const value of [0, 2, true, "1", null])
    assert.throws(
      () => decodeHandshake({ ...handshake, memoryStaticViews: value }),
      /memoryStaticViews/,
    );
  assert.deepEqual(decodeResponse(response), response);
  for (const requestedProfile of [
    {},
    { ...response.requestedProfile, eligible: false },
    { ...response.requestedProfile, issues: [{ path: "$.views", rule: "" }] },
    {
      ...response.requestedProfile,
      comparison: { equivalent: false, differences: [] },
    },
    {
      ...response.requestedProfile,
      comparison: { equivalent: true, differences: [{}] },
    },
  ])
    assert.throws(
      () => decodeResponse({ ...response, requestedProfile }),
      /requestedProfile/,
    );
});

test("V3 identities are reserved, not admitted to the existing document executor", () => {
  assert.equal(evidenceV3.profile, staticViewsProfile);
  assert.throws(
    () => documentEvidenceVersions(evidenceV3.scenario),
    /supported values/,
  );
  assert.throws(
    () =>
      parseTimelineDocument(
        JSON.stringify({ ...fixture().document, format: evidenceV3.scenario }),
      ),
    /supported values/,
  );
});

test("real inspection preserves Fleet classification and hashes exact supplied bytes", async () => {
  const result = await inspectStaticConfiguration(fleet, jar);
  assert.equal(result.documentProfile, "memory-sequence-fleet-v1");
  assert.deepEqual(result.requestedProfile, response.requestedProfile);
  assert.equal(result.execution, "not-checked");
  assert.equal(
    result.configurationHash,
    createHash("sha256")
      .update(await readFile(fleet))
      .digest("hex"),
  );
  const opened = await Bridge.open(jar, 0, 0, {
    runtimeGeneration: 1,
    startTimeMs: 0,
    firstTurnId: 0,
  });
  try {
    assert.equal(opened.bridge.memoryStaticViews, 1);
  } finally {
    await opened.bridge.close();
  }
});

test("production normalization permits only resource differences, separately from eligibility", async () => {
  const directory = await mkdtemp(join(tmpdir(), "static-admission-"));
  try {
    const reference = JSON.parse(await readFile(fleet, "utf8"));
    reference.maxStreams = 100000;
    reference.identityWindow = 10000;
    reference.maxHistoryEntries = 10000;
    reference.delivery.maxQueuedMessages = 1000;
    reference.delivery.maxQueuedBytes = 2000000;
    const path = join(directory, "reference.json");
    await writeFile(path, JSON.stringify(reference));
    const equivalent = await inspectStaticConfiguration(fleet, jar, path);
    assert.deepEqual(equivalent.requestedProfile.comparison, {
      equivalent: true,
      differences: [],
    });
    assert.equal(
      equivalent.referenceHash,
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    );
    const ineligible = await inspectStaticConfiguration(path, jar, fleet);
    assert.equal(ineligible.requestedProfile.eligible, false);
    assert.ok(
      ineligible.requestedProfile.issues.some(
        (issue) => issue.path === "$.maxStreams",
      ),
    );
    assert.equal(ineligible.requestedProfile.comparison?.equivalent, true);
    reference.sources[0].epoch = "changed-epoch";
    await writeFile(path, JSON.stringify(reference));
    const different = await inspectStaticConfiguration(fleet, jar, path);
    assert.equal(different.requestedProfile.eligible, true);
    assert.equal(different.requestedProfile.comparison?.equivalent, false);
    assert.ok(
      different.requestedProfile.comparison?.differences.some((issue) =>
        issue.path.includes("epoch"),
      ),
    );
    await writeFile(path, '{"contractVersion":2,"storage":"invented"}');
    await assert.rejects(
      inspectStaticConfiguration(fleet, jar, path),
      /Runtime exited/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configuration-only CLI reports eligibility without claiming scenario execution", () => {
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/timeline/inspect.ts",
        "static-configuration",
        fleet,
        jar,
        fleet,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(result.requestedProfile.eligible, true);
  assert.equal(result.requestedProfile.comparison.equivalent, true);
  assert.equal(result.execution, "not-checked");
});

test("requested inspection is rejected locally after startup without poisoning the generation", async () => {
  const { bridge } = await Bridge.open(jar, 0, 0, {
    runtimeGeneration: 1,
    startTimeMs: 0,
    firstTurnId: 0,
  });
  try {
    await bridge.command(0, {
      op: "initialize-document",
      wire: await readFile(fleet, "utf8"),
      profile: staticViewsProfile,
      epochMillis: 1700000000000,
    });
    await assert.rejects(
      bridge.command(0, {
        op: "inspect-requested-profile",
        wire: await readFile(fleet, "utf8"),
        profile: staticViewsProfile,
      }),
      /Invalid command for an initialized generation/,
    );
    const observed = await bridge.command(0, { op: "observe" });
    assert.deepEqual(observed.effects, []);
    await bridge.command(0, { op: "shutdown" });
  } finally {
    await bridge.close();
  }
});
