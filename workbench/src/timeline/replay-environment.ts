import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Bridge } from "./bridge.js";

/** Conservative matching boundary; cross-environment equivalence is not inferred. */
export async function captureEnvironment(bridge: Bridge) {
  if (!bridge.environment)
    throw new Error("unsupported-replay: artifact lacks environment identity");
  return {
    executor: "memory-arrival-v1/4",
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dependencyLockSha256: createHash("sha256")
      .update(
        await readFile(new URL("../../package-lock.json", import.meta.url)),
      )
      .digest("hex"),
    java: bridge.environment,
  };
}
