import { parseScenario, type Scenario } from "../scenario/scenario.js";
import {
  runtimeConfiguration,
  scenarioEpoch,
} from "../service/runtime-configuration.js";
import { encodeJson, parseJson, type Json } from "./json.js";
import { integer, list, object } from "./validation.js";

export type ConversionIssue = { path: string; reason: string };
export class ConversionEligibilityError extends Error {
  constructor(readonly issues: ConversionIssue[]) {
    super(
      `unsupported-conversion: ${issues.map(({ path, reason }) => `${path}: ${reason}`).join("; ")}`,
    );
  }
}

function fields(
  value: Json | undefined,
  path: string,
  allowed: string[],
  issues: ConversionIssue[],
) {
  const record = object(value, path);
  for (const key of Object.keys(record))
    if (!allowed.includes(key))
      issues.push({
        path: `${path}[${JSON.stringify(key)}]`,
        reason:
          "unsupported field; conversion never discards unknown constructs",
      });
  return record;
}

function safeIntegers(value: unknown, path: string): void {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value)
  )
    throw new ConversionEligibilityError([
      { path, reason: "unsafe integer in legacy input" },
    ]);
  if (Array.isArray(value))
    value.forEach((item, index) => safeIntegers(item, `${path}[${index}]`));
  else if (value !== null && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      safeIntegers(item, `${path}[${JSON.stringify(key)}]`);
}

/** Lossless first, then the ordinary parser: native-number rounding cannot alter authored values. */
export function conversionInput(legacy: string) {
  const raw = object(parseJson(legacy), "$");
  const native: unknown = JSON.parse(legacy);
  if (encodeJson(parseJson(JSON.stringify(native))) !== encodeJson(raw))
    throw new ConversionEligibilityError([
      {
        path: "$",
        reason:
          "numeric values cannot round-trip through the legacy parser without rounding",
      },
    ]);
  const issues: ConversionIssue[] = [];
  fields(raw, "$", ["name", "sources", "clients", "views", "timeline"], issues);
  list(raw.sources, "$.sources").forEach((entry, i) =>
    fields(entry, `$.sources[${i}]`, ["id", "name"], issues),
  );
  list(raw.clients, "$.clients").forEach((entry, i) => {
    const client = fields(
      entry,
      `$.clients[${i}]`,
      ["id", "name", "initialState"],
      issues,
    );
    if (!["connected", "disconnected"].includes(String(client.initialState)))
      issues.push({
        path: `$.clients[${i}].initialState`,
        reason:
          "transient initial client states require explicit connection semantics",
      });
  });
  const views = raw.views === undefined ? [] : list(raw.views, "$.views");
  views.forEach((value, i) => {
    const path = `$.views[${i}]`;
    const view = fields(value, path, ["id", "fields", "ordering"], issues);
    for (const [name, matchers] of Object.entries(
      object(view.fields, `${path}.fields`),
    )) {
      const fieldPath = `${path}.fields[${JSON.stringify(name)}]`;
      list(matchers, fieldPath).forEach((matcher, j) =>
        fields(matcher, `${fieldPath}[${j}]`, ["sourceId", "type"], issues),
      );
    }
    if (view.ordering !== undefined)
      for (const [name, value] of Object.entries(
        object(view.ordering, `${path}.ordering`),
      ))
        fields(
          value,
          `${path}.ordering[${JSON.stringify(name)}]`,
          ["mode", "sequenceField"],
          issues,
        );
  });
  const entries = list(raw.timeline, "$.timeline");
  const identities = new Set<string>();
  const publicationsAt = new Map<number, number>();
  entries.forEach((value, i) => {
    const path = `$.timeline[${i}]`;
    const entry = object(value, path);
    const at = integer(
      entry.simulationTime,
      `${path}.simulationTime`,
      3_600_000,
    );
    if (entry.kind === "source-event") {
      fields(
        entry,
        path,
        [
          "kind",
          "simulationTime",
          "sourceId",
          "type",
          "entityId",
          "payload",
          "epoch",
          "publicationSequence",
        ],
        issues,
      );
      integer(
        entry.publicationSequence,
        `${path}.publicationSequence`,
        Number.MAX_SAFE_INTEGER,
        1,
      );
      if (entry.epoch !== scenarioEpoch)
        issues.push({
          path: `${path}.epoch`,
          reason: `ordinary configuration uses epoch ${scenarioEpoch}`,
        });
      const identity = encodeJson([
        entry.sourceId,
        entry.epoch,
        entry.entityId,
        entry.publicationSequence,
      ]);
      if (identities.has(identity))
        issues.push({ path, reason: "repeated publication identity" });
      identities.add(identity);
      if (publicationsAt.has(at))
        issues.push({
          path,
          reason:
            "multiple publications at the same timestamp require explicit scheduling review",
        });
      publicationsAt.set(at, i);
    } else if (entry.kind === "view-check") {
      fields(
        entry,
        path,
        ["kind", "simulationTime", "viewId", "entityId", "expected"],
        issues,
      );
      if (entry.expected === null)
        issues.push({
          path: `${path}.expected`,
          reason: "absence assertions are outside this conversion subset",
        });
      else object(entry.expected, `${path}.expected`);
      if (
        entries.slice(i + 1).some((other) => {
          const next = object(other, "timeline entry");
          return (
            encodeJson(next.simulationTime) ===
              encodeJson(entry.simulationTime) && next.kind !== "view-check"
          );
        })
      )
        issues.push({
          path,
          reason: "check precedes a later same-time action",
        });
    } else
      issues.push({
        path: `${path}.kind`,
        reason:
          "only source-event and non-null view-check entries can be converted",
      });
  });
  if (issues.length) throw new ConversionEligibilityError(issues);
  const scenario = parseScenario(native);
  if (scenario.sources.length + scenario.clients.length > 10)
    throw new ConversionEligibilityError([
      {
        path: "$.clients",
        reason: "at most ten source/client actors in total",
      },
    ]);
  safeIntegers(native, "$");
  const referenceConfiguration = JSON.stringify(
    runtimeConfiguration(scenario.views, scenario.sources),
  );
  return { raw, scenario, referenceConfiguration };
}

export type ConversionInput = ReturnType<typeof conversionInput>;

/** Declared limits only: production still supplies defaults and decides configuration eligibility. */
export function resourceDeclarations(configuration: string) {
  const config = object(parseJson(configuration), "configuration");
  const delivery =
    config.delivery === undefined
      ? undefined
      : object(config.delivery, "configuration.delivery");
  return {
    maxStreams: integer(
      config.maxStreams,
      "configuration.maxStreams",
      Number.MAX_SAFE_INTEGER,
      1,
    ),
    identityWindow: integer(
      config.identityWindow,
      "configuration.identityWindow",
      Number.MAX_SAFE_INTEGER,
      1,
    ),
    maxHistoryEntries: integer(
      config.maxHistoryEntries,
      "configuration.maxHistoryEntries",
      Number.MAX_SAFE_INTEGER,
      1,
    ),
    delivery: {
      maxQueuedMessages:
        delivery?.maxQueuedMessages === undefined
          ? null
          : integer(
              delivery.maxQueuedMessages,
              "configuration.delivery.maxQueuedMessages",
              Number.MAX_SAFE_INTEGER,
              1,
            ),
      maxQueuedBytes:
        delivery?.maxQueuedBytes === undefined
          ? null
          : integer(
              delivery.maxQueuedBytes,
              "configuration.delivery.maxQueuedBytes",
              Number.MAX_SAFE_INTEGER,
              1,
            ),
    },
  };
}

export function checkConversionResources(
  input: ConversionInput,
  configuration: string,
) {
  const bounds = resourceDeclarations(configuration);
  const missing = Object.entries(bounds.delivery).filter(
    ([, value]) => value === null,
  );
  if (missing.length)
    throw new ConversionEligibilityError(
      missing.map(([name]) => ({
        path: `configuration.delivery.${name}`,
        reason:
          "supply this selected delivery bound explicitly; conversion does not infer production defaults",
      })),
    );
  const streams = new Map<string, { low: number; high: number }>();
  const histories = new Map<string, number>();
  const issues: ConversionIssue[] = [];
  for (const [i, entry] of input.scenario.timeline.entries()) {
    if (entry.kind !== "source-event") continue;
    const key = JSON.stringify([entry.sourceId, entry.epoch, entry.entityId]);
    const existing = streams.get(key);
    streams.set(key, {
      low: Math.min(
        existing?.low ?? entry.publicationSequence,
        entry.publicationSequence,
      ),
      high: Math.max(
        existing?.high ?? entry.publicationSequence,
        entry.publicationSequence,
      ),
    });
    const span = streams.get(key)!;
    if (span.high - span.low + 1 > bounds.identityWindow)
      issues.push({
        path: `$.timeline[${i}].publicationSequence`,
        reason:
          "whole-input sequence span exceeds the selected identity window",
      });
    for (const view of input.scenario.views)
      for (const [name, matchers] of Object.entries(view.fields)) {
        if (
          view.ordering?.[name]?.mode !== "historyBySequence" ||
          !matchers.some(
            (matcher) =>
              matcher.sourceId === entry.sourceId &&
              matcher.type === entry.type,
          )
        )
          continue;
        const historyKey = JSON.stringify([view.id, entry.entityId, name]);
        const count = (histories.get(historyKey) ?? 0) + 1;
        histories.set(historyKey, count);
        if (count > bounds.maxHistoryEntries)
          issues.push({
            path: `$.timeline[${i}]`,
            reason:
              "history contribution upper bound exceeds maxHistoryEntries",
          });
      }
  }
  if (streams.size > bounds.maxStreams)
    issues.push({
      path: "$.timeline",
      reason: "distinct stream count exceeds maxStreams",
    });
  if (issues.length) throw new ConversionEligibilityError(issues);
  return {
    resourceBounds: {
      reference: resourceDeclarations(input.referenceConfiguration),
      supplied: bounds,
      omittedDeliveryBounds: "production-default",
    },
    finiteInput: {
      streams: [...streams].map(([identity, span]) => ({
        identity: JSON.parse(identity) as string[],
        minimumSequence: span.low,
        maximumSequence: span.high,
        sequenceSpan: span.high - span.low + 1,
      })),
      histories: [...histories].map(([target, entries]) => ({
        target: JSON.parse(target) as string[],
        entries,
      })),
    },
  };
}

export function sourceActor(scenario: Scenario, sourceId: string) {
  const index = scenario.sources.findIndex((source) => source.id === sourceId);
  if (index < 0) throw new Error("unsupported-conversion: undeclared source");
  return `source-${index}`;
}
