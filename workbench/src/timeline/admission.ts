import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Bridge } from "./bridge.js";
import {
  format,
  lifecycleFormat,
  parseTimelineDocument,
  type TimelineDocument,
} from "./contract.js";
import {
  documentProfile,
  executionSettings,
  lifecycleDocumentProfile,
} from "./document-profile.js";
import { jsonLimits, parseJson } from "./json.js";
import { list, object, text } from "./validation.js";

export async function boundedFile(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    if (!(await file.stat()).isFile())
      throw new Error("invalid-admission: expected regular file");
    const bytes = Buffer.alloc(jsonLimits.bytes + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await file.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      length += bytesRead;
      if (length > jsonLimits.bytes)
        throw new Error("invalid-admission: file byte limit");
      if (bytesRead === 0) return bytes.subarray(0, length);
    }
  } finally {
    await file.close();
  }
}
export const decode = (bytes: Buffer) =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);

/** Resolve and hash the exact bytes before any runtime is started. */
export async function loadDocument(scenarioPath: string) {
  const scenario = parseTimelineDocument(
    decode(await boundedFile(scenarioPath)),
  );
  const runtime = object(scenario.document.runtime, "$.runtime");
  const configPath = resolve(
    dirname(scenarioPath),
    text(runtime.configuration, "$.runtime.configuration"),
  );
  const bytes = await boundedFile(configPath);
  const configurationHash = createHash("sha256").update(bytes).digest("hex");
  if (configurationHash !== text(runtime.sha256, "$.runtime.sha256")) {
    throw new Error("invalid-admission: configuration SHA-256 mismatch");
  }
  const wire = decode(bytes);
  return { scenario, wire, configurationHash };
}

/** Negotiate the requested lifecycle with the same artifact, without starting a runtime. */
export async function probeLifecycle(
  jar: string,
  artifact: string,
  scenario: TimelineDocument,
) {
  const opened = await Bridge.open(jar, 0, 0, {
    runtimeGeneration: 1,
    startTimeMs: 0,
    firstTurnId: 0,
  });
  try {
    if (opened.artifact !== artifact || opened.bridge.memoryLifecycle !== 1)
      throw new Error(
        "unsupported-execution: prepared artifact does not support memory lifecycle",
      );
    if (scenario.storage === "sqlite" && opened.bridge.sqliteLifecycle !== 1)
      throw new Error(
        "unsupported-execution: prepared artifact does not support SQLite lifecycle",
      );
    if (
      scenario.requiredCapabilities.includes("runtime-observations") &&
      opened.bridge.installedObservations !== 1
    )
      throw new Error(
        "unsupported-execution: prepared artifact does not support installed runtime observations",
      );
    if (
      scenario.requiredCapabilities.includes("wall-clock-adjustments") &&
      opened.bridge.wallClockAdjustments !== 1
    )
      throw new Error(
        "unsupported-execution: prepared artifact does not support wall clock adjustments",
      );
    if (!opened.bridge.environment)
      throw new Error(
        "unsupported-execution: lifecycle host lacks environment identity",
      );
    return opened.bridge.environment;
  } finally {
    await opened.bridge.close();
  }
}

export async function inspectRuntimeConfiguration(
  bridge: Bridge,
  wire: string,
  storage: TimelineDocument["storage"],
) {
  if (bridge.configurationAdmission !== 1)
    throw new Error(
      "unsupported-admission: prepared artifact has no configuration admission protocol",
    );
  const response = await bridge.command(0, {
    op: "inspect-configuration",
    wire,
  });
  if (
    response.effects.length ||
    response.pendingTasks ||
    response.heldFrames ||
    !response.configuration
  )
    throw new Error(
      "invalid-admission: configuration inspection produced runtime work or omitted result",
    );
  if (
    response.configuration.storage !== storage ||
    response.configuration.contractVersion !== 2
  )
    throw new Error(
      "invalid-admission: runtime configuration disagrees with scenario storage/version",
    );
  return response.configuration;
}

export function requiredConfigurationProfile(
  storage: TimelineDocument["storage"],
) {
  return storage === "sqlite" ? lifecycleDocumentProfile : documentProfile;
}

/** Production validated the wire configuration; only its declared view IDs are needed here. */
export function checkConfiguredTargets(
  scenario: TimelineDocument,
  wire: string,
) {
  if (!scenario.observationTargets.length) return;
  const configuration = object(parseJson(wire), "configuration");
  const views = new Set(
    list(configuration.views, "configuration.views").map((view) =>
      text(object(view, "configuration view").id, "configuration view ID"),
    ),
  );
  for (const { viewId, entityId } of scenario.observationTargets) {
    if (!views.has(viewId))
      throw new Error(
        `invalid-admission: unknown observation target view ${viewId}`,
      );
    // ECMAScript trim and Java String.isBlank use different whitespace sets.
    if (
      [...entityId].every((character) => {
        const point = character.codePointAt(0)!;
        return (
          (point >= 9 && point <= 13) ||
          (point >= 28 && point <= 32) ||
          (point >= 0x2000 && point <= 0x200a && point !== 0x2007) ||
          [0x1680, 0x2028, 0x2029, 0x205f, 0x3000].includes(point)
        );
      })
    )
      throw new Error(
        "invalid-admission: observation target entity is blank to the runtime",
      );
  }
}

/** Read once and preserve the exact configuration bytes validated by the runtime. */
export async function inspectAdmission(scenarioPath: string, jar: string) {
  const { scenario, wire, configurationHash } =
    await loadDocument(scenarioPath);
  const jarPath = resolve(jar);
  const lifecycle = scenario.format === lifecycleFormat;
  const { bridge, artifact } = await Bridge.open(jarPath);
  try {
    const configuration = await inspectRuntimeConfiguration(
      bridge,
      wire,
      scenario.storage,
    );
    const requiredProfile = requiredConfigurationProfile(scenario.storage);
    let reason: string | undefined;
    if (
      !bridge.documentFormats.includes(format) ||
      configuration.documentProfile !== requiredProfile
    )
      reason = `Prepared artifact/configuration does not support ${requiredProfile}.`;
    try {
      executionSettings(scenario, wire);
      checkConfiguredTargets(scenario, wire);
    } catch (error) {
      reason = String(error);
    }
    let artifactMemoryLifecycle: 0 | 1 = 0;
    let artifactSqliteLifecycle: 0 | 1 = 0;
    if (lifecycle && !reason) {
      try {
        await probeLifecycle(jarPath, artifact, scenario);
        artifactMemoryLifecycle = 1;
        if (scenario.storage === "sqlite") artifactSqliteLifecycle = 1;
      } catch (error) {
        reason = `Prepared artifact cannot negotiate ${scenario.storage} lifecycle. ${String(error)}`;
      }
    }
    return {
      artifact,
      configurationHash,
      configuration: "valid" as const,
      documentProfile: artifactMemoryLifecycle
        ? lifecycleDocumentProfile
        : configuration.documentProfile,
      format: scenario.format,
      artifactDocumentFormats: bridge.documentFormats,
      ...(lifecycle ? { artifactMemoryLifecycle } : {}),
      ...(scenario.storage === "sqlite" ? { artifactSqliteLifecycle } : {}),
      requiredCapabilities: scenario.requiredCapabilities,
      execution: reason ? "unsupported" : "eligible",
      reason:
        reason ??
        "Eligible for the bounded document executor; no actions have been executed.",
    };
  } finally {
    await bridge.close();
  }
}
