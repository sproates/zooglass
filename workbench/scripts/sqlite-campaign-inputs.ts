import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedFile, decode } from "../src/timeline/admission.js";
import {
  Decimal,
  encodeJson,
  parseJson,
  type Json,
} from "../src/timeline/json.js";
import { list, object } from "../src/timeline/validation.js";
import type { RestartCampaignGroup } from "./restart-campaign.js";

type Snapshot = readonly [
  entity: string,
  version: number,
  freshness: string,
  receiptWall: number | null,
];
export type SqliteExpectation = {
  thresholdMs: number;
  stopAt: number;
  restart: readonly [atMs: number, wallMillis: number];
  snapshots: readonly Snapshot[];
  wallAction?: readonly [
    atMs: number,
    generation: number | null,
    wallMillis: number,
  ];
  states: readonly (readonly [generation: number, atMs: number, ...Snapshot])[];
  alarms: readonly (readonly [generation: number, due: number])[];
  receipts: readonly (readonly [
    generation: number,
    atMs: number,
    status: string,
    reason: string,
    version: number,
  ])[];
  assertions: readonly (readonly [id: string, atMs: number])[];
  pauseTimes: readonly [Record<string, number>, Record<string, number>];
  restartCommand: readonly [operation: string, atMs: number];
  retry?: {
    timers: readonly (readonly [
      scheduled: number,
      due: number,
      kind: string,
    ])[];
    statuses: readonly (readonly [
      atMs: number,
      attempt: number,
      status: string,
    ])[];
    envelopes: readonly string[];
    unavailable: readonly [atMs: number, attempt: number];
    delivered: readonly [
      atMs: number,
      attempt: number,
      connectionGeneration: number,
    ];
    draws: readonly (readonly [
      atMs: number,
      attempt: number,
      lost: boolean,
      digest: string,
    ])[];
  };
};

type JsonObject = { [key: string]: Json };
const root = new URL("../scenarios/simulation/", import.meta.url);
const epoch = 1_700_000_000_000;
const source = "viewer-logical-source";
const viewer = "source-logical-client";
const target = { viewId: "stock-view", entityId: "sku-4" };
const number = (value: number) => new Decimal(String(value));
const read = (file: string) => boundedFile(fileURLToPath(new URL(file, root)));
const clone = (value: Json) =>
  object(parseJson(encodeJson(value)), "copied fixture");
const action = (
  id: string,
  atMs: number,
  kind: string,
  fields: JsonObject = {},
) => ({ id, atMs: number(atMs), kind, ...fields });
const assertion = (document: JsonObject, id: string) => {
  const item = list(document.assertions, "assertions")
    .map((value) => object(value, "assertion"))
    .find((value) => value.id === id);
  assert.ok(item, `missing literal assertion ${id}`);
  return item;
};
const snapshot = (document: JsonObject, id: string) =>
  object(
    object(assertion(document, id).expected, "expected").snapshot,
    "snapshot",
  );
const observe = (
  id: string,
  atMs: number,
  expected: JsonObject,
  entityId = target.entityId,
) => ({
  id,
  atMs: number(atMs),
  kind: "runtime-snapshot",
  ...target,
  entityId,
  expected: { outcome: "available", snapshot: expected },
});

export async function sqliteCampaignInputs(directory: string) {
  const durable = object(
    parseJson(decode(await read("sqlite-restart.json"))),
    "durable fixture",
  );
  const downtime = object(
    parseJson(decode(await read("sqlite-wall-rollback.json"))),
    "downtime fixture",
  );
  const restartConfig = "sqlite-restart-runtime.json";
  const wallConfig = "sqlite-wall-runtime.json";
  const originalReceipt = assertion(durable, "original-receipt");
  const duplicateReceipt = list(originalReceipt.expected, "receipts")[1];
  const oldActions = list(durable.actions, "actions");
  const retry = {
    ...durable,
    id: "sqlite-durable-retry",
    seed: "2".repeat(64),
    actions: [
      ...oldActions.slice(0, 4),
      action("viewer", 50, "connect", { actor: viewer }),
      action("view", 50, "client-subscribe", { actor: viewer, ...target }),
    ],
    assertions: [
      assertion(durable, "initial"),
      assertion(durable, "unavailable"),
      assertion(durable, "recovered"),
      { ...originalReceipt, expected: [duplicateReceipt] },
    ],
    faults: [
      {
        id: "drop-receipt",
        kind: "receipt-loss",
        action: "send",
        probability: { numerator: number(1), denominator: number(2) },
      },
    ],
    retries: [
      {
        action: "send",
        maxAttempts: number(3),
        receiptTimeoutMs: number(10),
        retryIntervalMs: number(0),
        unavailableRetryIntervalMs: number(30),
      },
    ],
  };

  // The checked-in example supplies complete literal envelopes. Entity B is a
  // separate fresh contribution whose original receipt predates startup wall time.
  const bFresh = clone(snapshot(downtime, "new-input-repairs-age"));
  bFresh.version = number(2);
  bFresh.entityId = "sku-5";
  object(
    object(bFresh.data, "snapshot data").reading,
    "reading",
  ).publicationSequence = number(1);
  object(
    object(bFresh.provenance, "provenance").reading,
    "reading",
  ).sourceEntityId = "sku-5";
  const status = object(bFresh.status, "view status");
  object(
    object(status.inputs, "inputs")["warehouse-feed"],
    "input",
  ).sourceEntityId = "sku-5";
  object(object(status.fields, "fields").reading, "reading").receivedAtMillis =
    number(epoch + 6);
  const bStale = clone(bFresh);
  bStale.version = number(4);
  object(
    object(object(bStale.status, "status").fields, "fields").reading,
    "reading",
  ).freshness = "stale";
  const maskedA = clone(snapshot(downtime, "unknown-after-recovery"));
  maskedA.version = number(3);
  const b = clone(list(durable.publications, "publications")[1]);
  b.id = "entity-b";
  const body = object(b.body, "publication body");
  body.sourceEntityId = "sku-5";
  body.publicationSequence = number(1);
  const masked = {
    ...downtime,
    id: "sqlite-masked-rollback",
    observationTargets: [target, { ...target, entityId: "sku-5" }],
    publications: [list(durable.publications, "publications")[0], b],
    actions: [
      ...oldActions.slice(0, 2),
      action("rollback", 20, "wall-clock-set", {
        wallMillis: number(epoch + 5),
      }),
      action("commit-b", 21, "source-send", {
        actor: source,
        publication: "entity-b",
      }),
      action("stop", 22, "service-stop", { mode: "abrupt" }),
      action("start", 50, "service-start"),
    ],
    assertions: [
      observe("a-uncertain", 50, maskedA),
      observe("b-fresh", 50, bFresh, "sku-5"),
      observe("b-expired", 71, bStale, "sku-5"),
    ],
    untilMs: number(71),
  };

  const definitions: {
    id: string;
    configuration: string;
    document: JsonObject;
    expected: SqliteExpectation;
  }[] = [
    {
      id: "durable-retry",
      configuration: restartConfig,
      document: retry,
      expected: {
        thresholdMs: 30,
        stopAt: 11,
        restart: [50, epoch + 50],
        snapshots: [["sku-4", 2, "stale", epoch + 10]],
        states: [[1, 10, "sku-4", 1, "fresh", epoch + 10]],
        alarms: [[1, 40]],
        receipts: [
          [1, 10, "committed", "sqlite", 1],
          [2, 50, "duplicate", "alreadyCommitted", 1],
        ],
        assertions: [
          ["initial", 0],
          ["unavailable", 15],
          ["recovered", 50],
          ["original-receipt", 50],
        ],
        pauseTimes: [{ "state-effect": 10 }, { "writer-handoff": 50 }],
        restartCommand: ["ingress", 50],
        retry: {
          unavailable: [20, 2],
          delivered: [50, 3, 2],
          timers: [
            [10, 20, "source-receipt-timeout"],
            [20, 20, "source-retry"],
            [20, 50, "source-retry"],
            [50, 60, "source-receipt-timeout"],
          ],
          statuses: [
            [20, 1, "timed-out"],
            [50, 3, "acknowledged"],
          ],
          envelopes: list(
            originalReceipt.expected,
            "literal durable receipts",
          ).map(encodeJson),
          // Independent SHA-256 over the documented length-prefixed fault-key fields.
          draws: [
            [
              10,
              1,
              true,
              "a2145cb06b2408576337a1290393d56fdf34f3c45e94770994a31f4125a1d7fb",
            ],
            [
              50,
              3,
              false,
              "c624a20f137e943e2d13a125aa8a09216e2a660e96e2488f9f1e720b662cff96",
            ],
          ],
        },
      },
    },
    {
      id: "downtime-rollback",
      configuration: wallConfig,
      document: downtime,
      expected: {
        thresholdMs: 50,
        stopAt: 11,
        restart: [21, epoch + 6],
        wallAction: [20, null, epoch + 5],
        snapshots: [["sku-4", 2, "ageUnknown", null]],
        states: [
          [1, 10, "sku-4", 1, "fresh", epoch + 10],
          [2, 30, "sku-4", 3, "fresh", epoch + 15],
          [2, 80, "sku-4", 4, "stale", epoch + 15],
        ],
        alarms: [
          [1, 60],
          [2, 80],
        ],
        receipts: [
          [1, 10, "committed", "sqlite", 1],
          [2, 22, "duplicate", "alreadyCommitted", 1],
          [2, 30, "committed", "sqlite", 3],
        ],
        assertions: [
          ["unknown-after-recovery", 21],
          ["duplicate-keeps-unknown", 22],
          ["new-input-repairs-age", 30],
          ["still-fresh", 79],
          ["expired", 80],
        ],
        pauseTimes: [
          { "state-effect": 10 },
          { "state-effect": 30, "alarm-dispatch": 80 },
        ],
        restartCommand: ["ingress", 30],
      },
    },
    {
      id: "masked-rollback",
      configuration: wallConfig,
      document: masked,
      expected: {
        thresholdMs: 50,
        stopAt: 22,
        restart: [50, epoch + 35],
        wallAction: [20, 1, epoch + 5],
        snapshots: [
          ["sku-4", 3, "ageUnknown", null],
          ["sku-5", 2, "fresh", epoch + 6],
        ],
        states: [
          [1, 10, "sku-4", 1, "fresh", epoch + 10],
          [1, 21, "sku-5", 2, "fresh", epoch + 6],
          [2, 71, "sku-5", 4, "stale", epoch + 6],
        ],
        alarms: [
          [1, 60],
          [2, 71],
        ],
        receipts: [
          [1, 10, "committed", "sqlite", 1],
          [1, 21, "committed", "sqlite", 2],
        ],
        assertions: [
          ["a-uncertain", 50],
          ["b-fresh", 50],
          ["b-expired", 71],
        ],
        pauseTimes: [
          { "state-effect": 10 },
          { "alarm-dispatch": 71, "state-effect": 71 },
        ],
        restartCommand: ["task", 71],
      },
    },
  ];
  const configuration = [restartConfig, wallConfig];
  await Promise.all(
    configuration.map(async (name) =>
      writeFile(join(directory, name), await read(name), { flag: "wx" }),
    ),
  );
  const groups: RestartCampaignGroup<SqliteExpectation>[] = await Promise.all(
    definitions.map(async ({ id, configuration, document, expected }) => {
      const filename = `${id}.json`;
      const path = join(directory, filename);
      const bytes = encodeJson(document) + "\n";
      await writeFile(path, bytes, { flag: "wx" });
      return { id, filename, path, bytes, configuration, expected };
    }),
  );
  return { configuration, groups };
}
