import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Bridge } from "./bridge.js";
import { format, parseTimelineDocument } from "./contract.js";
import { jsonLimits } from "./json.js";
import { object, text } from "./validation.js";

async function boundedFile(path: string): Promise<Buffer> {
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
const decode = (bytes: Buffer) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

/** Admission inspection only: validates config with the prepared artifact's production parser. */
export async function inspectAdmission(scenarioPath: string, jar: string) {
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
  const { bridge, artifact } = await Bridge.open(resolve(jar));
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
    return {
      artifact,
      configurationHash,
      configuration: "valid" as const,
      format,
      artifactDocumentFormats: bridge.documentFormats,
      requiredCapabilities: scenario.requiredCapabilities,
      execution: "unsupported" as const,
      reason:
        "No general document executor is qualified in Workbench; configuration validity is not execution admission.",
    };
  } finally {
    await bridge.close();
  }
}
