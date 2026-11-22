import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const lockScript = fileURLToPath(
  new URL("../../../scripts/benchmark-lock.py", import.meta.url),
);

/** Check the file identity and lock on the same open file description the worker/JVM inherit. */
export function verifyOwnership(directory: string, fd: number) {
  if (
    !Number.isSafeInteger(fd) ||
    fd < 3 ||
    !["darwin", "linux"].includes(process.platform)
  ) {
    throw new Error("A POSIX campaign lock descriptor is required");
  }
  execFileSync("python3", [lockScript, "--check", directory], {
    stdio: ["ignore", "pipe", "pipe", fd],
  });
}
