import { mkdtemp, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

// A tiny wrapper fixture exercises real child-process ownership without starting Maven.
export async function serviceFixture(
  t: TestContext,
  mode: "healthy" | "unhealthy" | "exit" | "stubborn",
) {
  const directory = await mkdtemp(join(tmpdir(), "workbench-service-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "service.mjs");
  await copyFile(
    new URL("../fixtures/process/service.js", import.meta.url),
    script,
  );
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(
    join(directory, "mvnw"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${quote(mode)} "$@"\n`,
    { mode: 0o755 },
  );
  return {
    directory,
    async started() {
      return JSON.parse(
        await readFile(join(directory, "started.json"), "utf8"),
      ) as { pid: number; config: string };
    },
  };
}
