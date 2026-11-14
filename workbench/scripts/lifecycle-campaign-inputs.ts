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

type PauseSites = Record<string, number>;
export type LifecycleExpectation = {
  stop: { atMs: number; mode: "abrupt" | "orderly" };
  restart: number;
  applied: readonly [number, number];
  expiry: readonly [number, number];
  retry: readonly [number, number, number];
  attemptsUnavailable: readonly (readonly [number, number])[];
  draws: readonly (readonly [
    number,
    number,
    number,
    number,
    boolean,
    string,
  ])[];
  assertions: readonly (readonly [string, number, number])[];
  pauses: readonly [PauseSites, PauseSites];
  retiredReceiptAt?: number;
};

type RecordJson = { [key: string]: Json };
const number = (value: number) => new Decimal(String(value));
const epoch = 1_700_000_000_000;
const source = "viewer-logical-source";
const client = "source-logical-client";
const configuration = "memory-restart-runtime.json";
const sourceDirectory = new URL("../scenarios/simulation/", import.meta.url);

const action = (
  id: string,
  atMs: number,
  kind: string,
  fields: RecordJson = {},
): RecordJson => ({ id, atMs: number(atMs), kind, ...fields });
const stop = (atMs: number, mode: "orderly" | "abrupt") =>
  action("stop", atMs, "service-stop", { mode });
const start = (atMs: number) => action("start", atMs, "service-start");
const connect = (actor: string, atMs: number, id: string) =>
  action(id, atMs, "connect", { actor });
const subscribe = (atMs: number, id: string) =>
  action(id, atMs, "client-subscribe", {
    actor: client,
    viewId: "stock-view",
    entityId: "sku-4",
  });
const send = (atMs: number) =>
  action("send", atMs, "source-send", {
    actor: source,
    publication: "report-1",
  });
const assertion = (
  id: string,
  atMs: number,
  kind: string,
  actor: string,
  expected: Json[],
): RecordJson => ({ id, atMs: number(atMs), kind, actor, expected });
const framesAt = (id: string, atMs: number, expected: Json[]) =>
  assertion(id, atMs, "client-frames", client, expected);
const receiptsAt = (id: string, atMs: number, expected: Json[]) =>
  assertion(id, atMs, "source-receipts", source, expected);

/** Reuse the complete literal envelopes in the checked-in scenario with the variant's declared receipt time. */
function receivedAt(frame: Json, atMs: number) {
  const copy = object(parseJson(encodeJson(frame)), "frame");
  const fields = object(object(copy.status, "status").fields, "fields");
  object(fields.reading, "reading").receivedAtMillis = number(epoch + atMs);
  return copy;
}

export async function lifecycleCampaignInputs(directory: string) {
  const templatePath = new URL("memory-restart.json", sourceDirectory);
  const sourceBytes = await boundedFile(fileURLToPath(templatePath));
  const template = object(parseJson(decode(sourceBytes)), "scenario");
  const assertions = list(template.assertions, "assertions").map((item) =>
    object(item, "assertion"),
  );
  const expected = (id: string) => {
    const match = assertions.find((item) => item.id === id);
    assert.ok(match, `missing authored assertion ${id}`);
    return list(match.expected, `${id}.expected`);
  };
  const [ack, empty, firstFresh] = expected("downtime");
  const finalStale = expected("new-expiry").at(-1)!;
  const receipt = expected("new-memory-receipt");
  const connectSource = connect(source, 0, "source-connect");

  const abrupt: RecordJson = {
    ...template,
    assertions: [
      framesAt("extra-downtime", 25, [ack, empty, firstFresh]),
      ...assertions,
    ],
  };
  const { faults: _faults, ...withoutFaults } = template;
  assert.ok(_faults, "abrupt template declares a receipt-loss rule");
  const orderly: RecordJson = {
    ...withoutFaults,
    id: "orderly-memory-restart",
    actions: [
      connectSource,
      stop(15, "orderly"),
      start(15),
      connect(client, 15, "client-connect"),
      subscribe(15, "subscribe"),
      send(15),
    ],
    assertions: [
      framesAt("fresh", 44, [ack, empty, receivedAt(firstFresh, 15)]),
      framesAt("stale", 45, [
        ack,
        empty,
        receivedAt(firstFresh, 15),
        receivedAt(finalStale, 15),
      ]),
      receiptsAt("applied", 45, receipt),
    ],
    untilMs: number(45),
  };
  const delayed: RecordJson = {
    ...withoutFaults,
    id: "delayed-memory-restart",
    links: [
      { actor: source, latencyMs: number(1) },
      { actor: client, latencyMs: number(0) },
    ],
    actions: [
      connectSource,
      connect(client, 0, "client-connect"),
      subscribe(0, "subscribe"),
      send(10),
      stop(12, "abrupt"),
      start(15),
      connect(client, 15, "new-viewer"),
      subscribe(15, "new-subscription"),
    ],
    assertions: [
      receiptsAt("no-retired-receipt", 19, []),
      framesAt("fresh", 50, [
        ack,
        empty,
        receivedAt(firstFresh, 11),
        ack,
        empty,
        receivedAt(firstFresh, 21),
      ]),
      framesAt("stale", 51, [
        ack,
        empty,
        receivedAt(firstFresh, 11),
        ack,
        empty,
        receivedAt(firstFresh, 21),
        receivedAt(finalStale, 21),
      ]),
      receiptsAt("applied", 51, receipt),
    ],
    untilMs: number(51),
  };

  const groups: {
    id: string;
    document: RecordJson;
    expected: LifecycleExpectation;
  }[] = [
    {
      id: "abrupt",
      document: abrupt,
      expected: {
        stop: { atMs: 11, mode: "abrupt" },
        restart: 50,
        applied: [10, 50],
        expiry: [40, 80],
        retry: [50, 3, 2],
        attemptsUnavailable: [[20, 2]],
        // Independently calculated over the documented length-prefixed fault key.
        draws: [
          [
            10,
            1,
            1,
            1,
            true,
            "165d8f5c6108ee18d41c586533fb89f5fa904cc18b666cb86efa7b98ebaad05e",
          ],
          [
            50,
            2,
            2,
            3,
            false,
            "ac5c28c363d2dd80f0406fe2730a1e5af2a1a4216b932a18a34261ce1b8a7534",
          ],
        ],
        assertions: [
          ["extra-downtime", 25, 3],
          ["downtime", 30, 3],
          ["no-receipt-while-stopped", 30, 0],
          ["fresh-after-restart", 79, 6],
          ["new-expiry", 80, 7],
          ["new-memory-receipt", 80, 1],
        ],
        pauses: [
          { "writer-handoff": 0, "state-effect": 10 },
          { "writer-handoff": 50, "state-effect": 50, "alarm-dispatch": 80 },
        ],
      },
    },
    {
      id: "orderly",
      document: orderly,
      expected: {
        stop: { atMs: 15, mode: "orderly" },
        restart: 15,
        applied: [-1, 15],
        expiry: [-1, 45],
        retry: [15, 1, 2],
        attemptsUnavailable: [],
        draws: [],
        assertions: [
          ["fresh", 44, 3],
          ["stale", 45, 4],
          ["applied", 45, 1],
        ],
        pauses: [
          {},
          { "writer-handoff": 15, "state-effect": 15, "alarm-dispatch": 45 },
        ],
      },
    },
    {
      id: "delayed",
      document: delayed,
      expected: {
        stop: { atMs: 12, mode: "abrupt" },
        restart: 15,
        applied: [11, 21],
        expiry: [41, 51],
        retry: [20, 2, 2],
        attemptsUnavailable: [],
        draws: [],
        retiredReceiptAt: 12,
        assertions: [
          ["no-retired-receipt", 19, 0],
          ["fresh", 50, 6],
          ["stale", 51, 7],
          ["applied", 51, 1],
        ],
        pauses: [
          { "writer-handoff": 0, "state-effect": 11 },
          { "writer-handoff": 15, "state-effect": 21, "alarm-dispatch": 51 },
        ],
      },
    },
  ];
  const configurationBytes = await boundedFile(
    fileURLToPath(new URL(configuration, sourceDirectory)),
  );
  await writeFile(join(directory, configuration), configurationBytes, {
    flag: "wx",
  });
  return {
    configuration,
    groups: await Promise.all(
      groups.map(async ({ id, document, expected }) => {
        const filename = `${id}.json`;
        const path = join(directory, filename);
        const bytes = encodeJson(document) + "\n";
        await writeFile(path, bytes, { flag: "wx" });
        return { id, filename, path, bytes, expected };
      }),
    ),
  };
}
