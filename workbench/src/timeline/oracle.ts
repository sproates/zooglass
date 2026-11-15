import assert from "node:assert/strict";

type Version = readonly [number, number, "fresh" | "stale", number];
type Observations = {
  states: readonly string[];
  receipts: readonly string[];
  clients: ReadonlyMap<string, readonly string[]>;
};

// Independent fixture expectations, not projections of runtime snapshots.
const identity = { epoch: "v1", sourceEntityId: "bus", sourceId: "feed" };
const firstPayloadWire =
  '{"d":1.0000000000000000001,"n":9007199254740993,"nested":{"a":1,"b":2},"z":0}';
const acknowledgement = {
  entityId: "bus",
  recovery: "freshSnapshot",
  type: "subscribed",
  viewId: "position",
};
const receiptVersions: readonly Version[] = [
  [1, 1, "fresh", 1_000_010],
  [2, 1, "stale", 1_000_010],
  [3, 2, "fresh", 1_000_110],
  [4, 2, "stale", 1_000_110],
];
const deliveryVersions: readonly Version[] = [
  [1, 1, "fresh", 1_000_010],
  [2, 2, "fresh", 1_000_020],
  [3, 3, "fresh", 1_000_020],
  [4, 4, "fresh", 1_000_020],
  [5, 4, "stale", 1_000_020],
];

function expectedStatus(version?: Version) {
  return {
    fields: {
      position: {
        freshness: version?.[2] ?? "absent",
        inputs: ["feed"],
        receivedAtMillis: version?.[3] ?? null,
      },
    },
    inputs: {
      feed: {
        admissionFloor: version ? 1 : null,
        completeThrough: null,
        completeness: "unknown",
        epoch: "v1",
        missingRanges: [],
        mode: "untracked",
        observedThrough: null,
        sourceContractViolated: false,
        sourceEntityId: "bus",
        startSequence: null,
        state: version ? "observed" : "notObserved",
        watermarkThrough: null,
      },
    },
    missingFields: version ? [] : ["position"],
    missingRequiredFields: [],
    publication: version ? "ready" : "partial",
  };
}

function expectedSnapshot(version?: Version, publicFrame = true) {
  const sequence = version?.[1];
  // Structural comparison covers the whole envelope. Exact wire checks below
  // separately protect payload numbers that JavaScript cannot represent.
  const payload: unknown =
    sequence === 1 ? JSON.parse(firstPayloadWire) : { value: sequence };
  return {
    data: version
      ? {
          position: publicFrame
            ? payload
            : { payload, publicationSequence: sequence },
        }
      : {},
    entityId: "bus",
    provenance: version ? { position: identity } : {},
    ...(publicFrame
      ? {
          publicationSequences: version ? { position: [sequence] } : {},
          type: "view-update",
        }
      : {}),
    status: expectedStatus(version),
    version: version?.[0] ?? 0,
    viewId: "position",
  };
}

function assertSnapshot(
  wire: string,
  version: Version | undefined,
  label: string,
  publicFrame = true,
) {
  assert.deepEqual(
    JSON.parse(wire),
    expectedSnapshot(version, publicFrame),
    label,
  );
  if (version?.[1] === 1) {
    const field = publicFrame ? "position" : "payload";
    assert.ok(
      wire.includes(`"${field}":${firstPayloadWire}`),
      `${label}: exact large integer and decimal payload`,
    );
  }
}

function expectedReceipt(sequence: number, version: number, duplicate = false) {
  return {
    changedViews: duplicate ? [] : ["position"],
    publicationSequence: sequence,
    reason: duplicate ? "alreadyApplied" : "memory",
    status: duplicate ? "duplicate" : "applied",
    stream: identity,
    targets: [
      {
        changedFields: ["position"],
        entityId: "bus",
        fields: [
          {
            changed: true,
            field: "position",
            reason: null,
            status: "accepted",
          },
        ],
        reason: null,
        status: "accepted",
        viewId: "position",
      },
    ],
    version,
  };
}

export function assertProofOutputs(
  observations: Observations,
  scenario: "receipt" | "delivery",
  lost: boolean,
) {
  const versions = scenario === "receipt" ? receiptVersions : deliveryVersions;
  assert.equal(
    observations.states.length,
    versions.length,
    "state transition count",
  );
  versions.forEach((version, index) =>
    assertSnapshot(
      observations.states[index],
      version,
      `state transition ${index}`,
      false,
    ),
  );

  const receipts =
    scenario === "receipt"
      ? [
          expectedReceipt(1, 1),
          ...(lost ? [expectedReceipt(1, 1, true)] : []),
          expectedReceipt(2, 3),
        ]
      : [
          expectedReceipt(1, 1),
          expectedReceipt(2, 2),
          expectedReceipt(3, 3),
          expectedReceipt(4, 4),
        ];
  assert.equal(
    observations.receipts.length,
    receipts.length,
    "publication receipt count",
  );
  receipts.forEach((expected, index) =>
    assert.deepEqual(
      JSON.parse(observations.receipts[index]),
      expected,
      `publication receipt ${index}`,
    ),
  );

  assert.deepEqual([...observations.clients.keys()].sort(), [
    "viewer-healthy",
    "viewer-slow",
  ]);
  for (const session of ["viewer-slow", "viewer-healthy"]) {
    const delivered =
      scenario === "receipt"
        ? receiptVersions
        : session === "viewer-slow"
          ? [deliveryVersions[3], deliveryVersions[4]]
          : [deliveryVersions[0], deliveryVersions[3], deliveryVersions[4]];
    const frames = observations.clients.get(session)!;
    assert.equal(
      frames.length,
      delivered.length + 2,
      `client ${session} frame count`,
    );
    assert.deepEqual(
      JSON.parse(frames[0]),
      acknowledgement,
      `client ${session} acknowledgement`,
    );
    assertSnapshot(frames[1], undefined, `client ${session} baseline`);
    delivered.forEach((version, index) =>
      assertSnapshot(
        frames[index + 2],
        version,
        `client ${session} frame ${index + 2}`,
      ),
    );
  }
}
