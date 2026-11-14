import assert from "node:assert/strict";
import test from "node:test";
import { Bridge } from "../../src/timeline/bridge.js";
import {
  probeLifecycle,
  requiredConfigurationProfile,
} from "../../src/timeline/admission.js";
import { parseTimelineDocument } from "../../src/timeline/contract.js";
import { fleetProfile } from "../../src/timeline/evidence-versions.js";
import { decodeHandshake } from "../../src/timeline/host-protocol.js";
import { action, fixture, source } from "./document-fixture.js";

function document() {
  const input = fixture().document;
  return {
    ...input,
    format: "timeline-simulation/v2",
    runtime: {
      ...input.runtime,
      sha256: "a".repeat(64),
      profile: fleetProfile,
    },
  };
}
const parse = (input: unknown) => parseTimelineDocument(JSON.stringify(input));

test("explicit fleet profile is v2 memory only and leaves omitted identities unchanged", () => {
  const input = document();
  assert.equal(parse(input).profile, fleetProfile);
  assert.equal(requiredConfigurationProfile(parse(input)), fleetProfile);
  const { profile, ...runtime } = input.runtime;
  assert.equal(profile, fleetProfile);
  assert.equal(parse({ ...input, runtime }).profile, "receipt-age-restart-v1");
  assert.equal(
    requiredConfigurationProfile(parse({ ...input, runtime })),
    "memory-arrival-v1",
  );
  assert.equal(
    parse({ ...input, runtime, format: "timeline-simulation/v1" }).profile,
    "memory-arrival-v1",
  );
  assert.throws(
    () => parse({ ...input, format: "timeline-simulation/v1" }),
    /profile: unknown field/,
  );
  assert.throws(
    () => parse({ ...input, runtime: { ...input.runtime, storage: "sqlite" } }),
    /requires memory storage/,
  );
  assert.throws(
    () =>
      parse({
        ...input,
        runtime: { ...input.runtime, profile: "memory-arrival-v1" },
      }),
    /profile: supported values/,
  );
});

test("fleet rejects each service and wall clock action but retains actor reconnects", () => {
  const input = document();
  for (const control of [
    { kind: "service-stop", mode: "orderly" },
    { kind: "service-start" },
    { kind: "wall-clock-set", wallMillis: 10 },
  ])
    assert.throws(
      () =>
        parse({ ...input, actions: [{ id: "control", atMs: 0, ...control }] }),
      /does not support runtime lifecycle or wall clock actions/,
    );
  assert.doesNotThrow(() =>
    parse({
      ...input,
      assertions: [],
      actions: [
        action("connect", 0, "connect", source),
        action("disconnect", 1, "disconnect", source),
        action("reconnect", 2, "connect", source),
      ],
    }),
  );
});

test("fleet capability is separately negotiated before runtime commands", async (context) => {
  let commands = 0;
  let closed = 0;
  const bridge = {
    memoryLifecycle: 1,
    memorySequenceFleet: 0,
    command: () => {
      commands++;
    },
    close: async () => {
      closed++;
    },
    environment: { javaRuntime: "25" },
  };
  context.mock.method(Bridge, "open", async () => ({
    artifact: "artifact",
    bridge,
  }));
  await assert.rejects(
    probeLifecycle("unused.jar", "artifact", parse(document())),
    /does not support memory sequence fleet/,
  );
  assert.equal(commands, 0);
  assert.equal(closed, 1);
  bridge.memorySequenceFleet = 1;
  assert.deepEqual(
    await probeLifecycle("unused.jar", "artifact", parse(document())),
    bridge.environment,
  );
  assert.equal(commands, 0);
});

test("host protocol validates fleet capability independently of lifecycle support", () => {
  const handshake = {
    protocol: 2,
    fixture: "timeline-proof-v1",
    artifact: "a".repeat(64),
    frameCap: 1024,
    storage: ["memory"],
    protectedAccess: false,
    memoryLifecycle: 1,
    documentFormats: [],
    environment: { javaRuntime: "25" },
  };
  assert.doesNotThrow(() => decodeHandshake(handshake));
  assert.doesNotThrow(() =>
    decodeHandshake({ ...handshake, memorySequenceFleet: 1 }),
  );
  for (const memorySequenceFleet of [0, 2, true, "1", null])
    assert.throws(
      () => decodeHandshake({ ...handshake, memorySequenceFleet }),
      /handshake.memorySequenceFleet/,
    );
});
