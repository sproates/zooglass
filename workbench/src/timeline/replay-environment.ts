import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Bridge } from "./bridge.js";
import type { Json } from "./json.js";
import { object, text } from "./validation.js";

/** Conservative matching boundary; cross-environment equivalence is not inferred. */
export async function captureEnvironment(bridge: Bridge) {
  if (!bridge.environment)
    throw new Error("unsupported-replay: artifact lacks environment identity");
  return {
    executor: "memory-arrival-v1/5",
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

/** Check the recorded identity without consulting the current machine or starting Java. */
export function validateRecordedEnvironment(
  value: Json,
  storage: "memory" | "sqlite",
) {
  const textFields = [
    "executor",
    "node",
    "v8",
    "platform",
    "arch",
    "locale",
    "timezone",
  ];
  const environment = object(value, "environment", [
    ...textFields,
    "dependencyLockSha256",
    "java",
  ]);
  for (const key of textFields) text(environment[key], `environment.${key}`);
  if (
    !/^[a-f0-9]{64}$/.test(
      text(environment.dependencyLockSha256, "dependencyLockSha256"),
    )
  )
    throw new Error("Invalid environment dependency hash");
  const java = object(environment.java, "environment.java", [
    "javaRuntime",
    "javaVendor",
    "os",
    "arch",
    "locale",
    "timezone",
    ...(storage === "sqlite" ? ["sqliteVersion"] : []),
  ]);
  for (const key of Object.keys(java))
    text(java[key], `environment.java.${key}`);
  return environment;
}
