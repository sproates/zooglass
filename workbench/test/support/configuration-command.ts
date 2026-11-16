import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
const execute = promisify(execFile);
export const jar = resolve("../zooglass/target/zooglass.jar");

export async function runConfiguration(
  args: string[],
  cwd?: string,
  properties: string[] = [],
  artifact = jar,
) {
  try {
    const result = await execute(
      "java",
      [...properties, "-jar", artifact, "config", ...args],
      {
        cwd,
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    assert.equal(result.stderr, "");
    return { code: 0, stdout: result.stdout };
  } catch (error) {
    const result = error as Error & {
      code: number;
      stdout: string;
      stderr: string;
      killed: boolean;
    };
    assert.equal(
      result.killed,
      false,
      "offline command must finish without starting a service",
    );
    assert.equal(typeof result.code, "number");
    assert.equal(result.stderr, "");
    return { code: result.code, stdout: result.stdout };
  }
}
