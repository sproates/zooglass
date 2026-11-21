import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { boundedFile, decode } from "./file-input.js";
import { Bridge } from "./bridge.js";
import {
  staticViewsProfile,
  staticRecoveryProfile,
} from "./evidence-versions.js";

/** Ask the production decoder about a family without reclassifying older profiles. */
export async function inspectRequestedConfiguration(
  bridge: Pick<Bridge, "memoryStaticViews" | "staticViewsRestart" | "command">,
  wire: string,
  referenceWire?: string,
  profile:
    | typeof staticViewsProfile
    | typeof staticRecoveryProfile = staticViewsProfile,
) {
  if (
    (profile === staticRecoveryProfile
      ? bridge.staticViewsRestart
      : bridge.memoryStaticViews) !== 1
  )
    throw new Error(
      "unsupported-admission: prepared artifact has no static-view admission capability",
    );
  const response = await bridge.command(0, {
    op: "inspect-requested-profile",
    profile,
    wire,
    ...(referenceWire === undefined ? {} : { referenceWire }),
  });
  if (
    response.effects.length ||
    response.pendingTasks ||
    response.heldFrames ||
    response.snapshots !== undefined ||
    response.configuration?.contractVersion !== 2 ||
    response.requestedProfile?.profile !== profile ||
    (response.requestedProfile.comparison !== undefined) !==
      (referenceWire !== undefined)
  )
    throw new Error(
      "invalid-admission: requested-profile inspection produced runtime work or mismatched result",
    );
  return {
    configuration: response.configuration,
    requestedProfile: response.requestedProfile,
  };
}

async function configurationFile(path: string) {
  const bytes = await boundedFile(path);
  return {
    wire: decode(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Inspect exact file bytes only: no actions, conversion, Java build or runtime startup. */
export async function inspectStaticConfiguration(
  configurationPath: string,
  jar: string,
  referencePath?: string,
) {
  const supplied = await configurationFile(configurationPath);
  const reference =
    referencePath === undefined
      ? undefined
      : await configurationFile(referencePath);
  const { bridge, artifact } = await Bridge.open(resolve(jar));
  try {
    const result = await inspectRequestedConfiguration(
      bridge,
      supplied.wire,
      reference?.wire,
    );
    return {
      artifact,
      configurationHash: supplied.sha256,
      ...(reference ? { referenceHash: reference.sha256 } : {}),
      configuration: "valid" as const,
      documentProfile: result.configuration.documentProfile,
      requestedProfile: result.requestedProfile,
      execution: "not-checked" as const,
    };
  } finally {
    await bridge.close();
  }
}
