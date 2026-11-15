import { createHash } from "node:crypto";
import {
  checkConversionResources,
  conversionInput,
  sourceActor,
} from "./conversion-eligibility.js";
import { evidenceV3, staticViewsProfile } from "./evidence-versions.js";
import { encodeJson, parseJson, type Json } from "./json.js";
import { list, object } from "./validation.js";

export const conversionFiles = {
  scenario: "scenario.json",
  configuration: "configuration.json",
  report: "conversion-report.json",
  legacy: "legacy.json",
} as const;
export const conversionVersion = "legacy-static-conversion/v1";
export const conversionReportFormat = "timeline-conversion/v1";
export type ConversionOptions = { epochMillis: number; seed: string };
export const conversionHash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => parseJson(JSON.stringify(value));

/** Deterministic transcription, shared by the writer and offline provenance validation. Never evaluates outcomes. */
export function conversionDocument(
  legacy: string,
  configuration: string,
  options: ConversionOptions,
) {
  if (!Number.isSafeInteger(options.epochMillis) || options.epochMillis < 0)
    throw new Error(
      "invalid-conversion: epochMillis must be a nonnegative safe integer",
    );
  if (!/^[a-f0-9]{64}$/.test(options.seed))
    throw new Error(
      "invalid-conversion: seed must be 64 lowercase hexadecimal characters",
    );
  const input = conversionInput(legacy);
  const resources = checkConversionResources(input, configuration);
  const { scenario, raw } = input;
  const actors = [
    ...scenario.sources.map((_, i) => ({ id: `source-${i}`, role: "source" })),
    ...scenario.clients.map((_, i) => ({ id: `client-${i}`, role: "client" })),
  ];
  const actions: Json[] = scenario.sources.map((_, i) =>
    json({
      id: `connect-source-${i}`,
      atMs: 0,
      kind: "connect",
      actor: `source-${i}`,
    }),
  );
  const mapping: { path: string; targets: string[] }[] = scenario.sources.map(
    (_, i) => ({
      path: `$.sources[${i}]`,
      targets: [`actor:source-${i}`, `action:connect-source-${i}`],
    }),
  );
  scenario.clients.forEach((client, i) => {
    const targets = [`actor:client-${i}`];
    if (client.initialState === "connected") {
      actions.push(
        json({
          id: `connect-client-${i}`,
          atMs: 0,
          kind: "connect",
          actor: `client-${i}`,
        }),
      );
      targets.push(`action:connect-client-${i}`);
    }
    mapping.push({ path: `$.clients[${i}]`, targets });
  });
  const publications: Json[] = [];
  const assertions: Json[] = [];
  const preservedExpectations: Json[] = [];
  const observationTargets = new Map<
    string,
    { viewId: string; entityId: string }
  >();
  const rawEntries = list(raw.timeline, "$.timeline");
  let untilMs = 0;
  scenario.timeline.forEach((entry, i) => {
    untilMs = Math.max(untilMs, entry.simulationTime);
    const original = object(rawEntries[i], `$.timeline[${i}]`);
    if (entry.kind === "source-event") {
      const actor = sourceActor(scenario, entry.sourceId);
      publications.push({
        id: `publication-${i}`,
        body: {
          sourceId: original.sourceId,
          epoch: original.epoch,
          sourceEntityId: original.entityId,
          publicationSequence: original.publicationSequence,
          type: original.type,
          payload: original.payload,
        },
      });
      actions.push(
        json({
          id: `send-${i}`,
          atMs: entry.simulationTime,
          kind: "source-send",
          actor,
          publication: `publication-${i}`,
        }),
      );
      assertions.push(
        json({
          id: `accepted-${i}`,
          atMs: entry.simulationTime,
          kind: "source-accepted",
          actor,
          send: `send-${i}`,
        }),
      );
      mapping.push({
        path: `$.timeline[${i}]`,
        targets: [
          `publication:publication-${i}`,
          `action:send-${i}`,
          `assertion:accepted-${i}`,
        ],
      });
    } else if (entry.kind === "view-check") {
      const target = { viewId: entry.viewId, entityId: entry.entityId };
      observationTargets.set(
        JSON.stringify([entry.viewId, entry.entityId]),
        target,
      );
      assertions.push({
        ...object(
          json({
            id: `check-${i}`,
            atMs: entry.simulationTime,
            kind: "runtime-data",
            ...target,
          }),
          "assertion",
        ),
        expected: original.expected,
      });
      preservedExpectations.push({
        path: `$.timeline[${i}].expected`,
        assertion: `check-${i}`,
        expected: original.expected,
      });
      mapping.push({
        path: `$.timeline[${i}]`,
        targets: [`assertion:check-${i}`],
      });
    }
  });
  if (!Number.isSafeInteger(options.epochMillis + untilMs))
    throw new Error(
      "invalid-conversion: epoch plus horizon exceeds safe integer range",
    );
  const document: Json = {
    ...object(
      json({
        format: evidenceV3.scenario,
        id: `converted-${conversionHash(legacy).slice(0, 24)}`,
        clock: { epochMillis: options.epochMillis },
        seed: options.seed,
        runtime: {
          configuration: conversionFiles.configuration,
          sha256: conversionHash(configuration),
          storage: "memory",
          access: "unprotected",
          initialState: "empty",
          profile: staticViewsProfile,
        },
        conversionReport: conversionFiles.report,
        actors,
        links: actors.map((actor) => ({ actor: actor.id, latencyMs: 0 })),
        observationTargets: [...observationTargets.values()],
        limits: {
          turns: 2000,
          rounds: 100,
          queuedEvents: 1000,
          pendingMessages: 1000,
          traceBytes: 16777216,
        },
        untilMs,
        end: {
          pendingFutureTasks: "forbid",
          pendingMessages: 0,
          heldFrames: 0,
        },
      }),
      "document",
    ),
    publications,
    actions,
    assertions,
  };
  const canonical = encodeJson(document);
  const semanticReport = {
    options,
    referenceConfiguration: input.referenceConfiguration,
    mapping,
    preservedExpectations,
    ...resources,
    adaptations: [
      "Caller supplied five explicit resource bounds replace compiler defaults; omitted reference delivery bounds identify production defaults.",
      "Numeric admission floors can differ; the whole-input span prevents introduced receipt eviction or out-of-order rejection for these inputs.",
      "Source connections occur at virtual time zero; initially connected clients connect without subscriptions.",
      "HTTP expected-value waits become settled public-data assertions; transport, native timing and complete original envelopes are not asserted.",
      "Each source send gains an explicit acceptance assertion preserving the ordinary runner's implicit receipt check.",
    ],
    rejectedConstructs: [],
  };
  return { document, canonical, semanticReport };
}

export function conversionReport(
  legacy: string,
  configuration: string,
  options: ConversionOptions,
  identity: { workbenchSha256: string; artifactSha256: string },
) {
  const plan = conversionDocument(legacy, configuration, options);
  const report: Json = {
    ...object(
      json({
        format: conversionReportFormat,
        converter: { version: conversionVersion, ...identity },
        files: {
          legacy: {
            path: conversionFiles.legacy,
            bytes: Buffer.byteLength(legacy),
            sha256: conversionHash(legacy),
          },
          configuration: {
            path: conversionFiles.configuration,
            bytes: Buffer.byteLength(configuration),
            sha256: conversionHash(configuration),
          },
        },
        scenarioCanonicalSha256: conversionHash(plan.canonical),
      }),
      "report",
    ),
    ...object(
      json({ ...plan.semanticReport, preservedExpectations: [] }),
      "semantic report",
    ),
    preservedExpectations: plan.semanticReport.preservedExpectations,
  };
  return { ...plan, report: encodeJson(report) };
}
