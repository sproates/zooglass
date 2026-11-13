import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Bridge } from "./bridge.js";
import { format, lifecycleFormat, parseTimelineDocument } from "./contract.js";
import {
  documentProfile,
  executionSettings,
  lifecycleDocumentProfile,
} from "./document-profile.js";
import { jsonLimits } from "./json.js";
import { object, text } from "./validation.js";

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

/** Verify that the same artifact can negotiate memory lifecycle without starting a runtime. */
export async function probeMemoryLifecycle(jar: string, artifact: string) {
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
  } finally {
    await opened.bridge.close();
  }
}

/** Read once and preserve the exact configuration bytes validated by the runtime. */
export async function inspectAdmission(scenarioPath: string, jar: string) {
  const { scenario, wire, configurationHash } =
    await loadDocument(scenarioPath);
  const runtime = object(scenario.document.runtime, "$.runtime");
  const jarPath = resolve(jar);
  const lifecycle = scenario.format === lifecycleFormat;
  const { bridge, artifact } = await Bridge.open(jarPath);
  try {
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
      response.configuration.storage !== runtime.storage ||
      response.configuration.contractVersion !== 2
    )
      throw new Error(
        "invalid-admission: runtime configuration disagrees with scenario storage/version",
      );
    let reason: string | undefined;
    if (
      !bridge.documentFormats.includes(format) ||
      response.configuration.documentProfile !== documentProfile
    )
      reason =
        "Prepared artifact/configuration does not support memory-arrival-v1.";
    try {
      executionSettings(scenario, wire);
    } catch (error) {
      reason = String(error);
    }
    let artifactMemoryLifecycle: 0 | 1 = 0;
    if (lifecycle && !reason) {
      try {
        await probeMemoryLifecycle(jarPath, artifact);
        artifactMemoryLifecycle = 1;
      } catch (error) {
        reason = `Prepared artifact cannot negotiate memory lifecycle. ${String(error)}`;
      }
    }
    return {
      artifact,
      configurationHash,
      configuration: "valid" as const,
      documentProfile: artifactMemoryLifecycle
        ? lifecycleDocumentProfile
        : response.configuration.documentProfile,
      format: scenario.format,
      artifactDocumentFormats: bridge.documentFormats,
      ...(lifecycle ? { artifactMemoryLifecycle } : {}),
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
