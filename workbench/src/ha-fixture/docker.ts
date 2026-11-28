import { spawn } from "node:child_process";
export type CommandRunner = (
  args: readonly string[],
  input?: string,
  signal?: AbortSignal,
) => Promise<string>;
export const docker: CommandRunner = (args, input, signal) =>
  new Promise((resolve, reject) => {
    const timeout = AbortSignal.timeout(30_000);
    const child = spawn("docker", [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      killSignal: "SIGKILL",
    });
    let output = "",
      error = "";
    const limit = 1024 * 1024;
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (Buffer.byteLength(output) > limit) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      error += String(chunk);
      if (Buffer.byteLength(error) > limit) child.kill("SIGKILL");
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve((args[0] === "logs" ? output + error : output).trim())
        : reject(
            new Error(
              `Docker ${args[0]} failed (${code}): ${error.slice(-4096)}`,
            ),
          ),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
/** Register ownership before creation, including ambiguous create results. Never discover/delete unrelated resources. */
export class OwnedDocker {
  private readonly resources: {
    kind: "container" | "network";
    name: string;
  }[] = [];
  constructor(private readonly run: CommandRunner = docker) {}
  async create(
    kind: "container" | "network",
    name: string,
    args: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    this.resources.push({ kind, name });
    await this.run(
      kind === "network"
        ? ["network", "create", ...args, name]
        : ["create", "--name", name, ...args],
      undefined,
      signal,
    );
  }
  async close(): Promise<void> {
    const failures: unknown[] = [];
    for (const resource of [...this.resources].reverse()) {
      const prefix = resource.kind === "network" ? ["network"] : [];
      try {
        await this.run([
          ...prefix,
          "rm",
          ...(resource.kind === "container" ? ["-f", "--volumes"] : []),
          resource.name,
        ]);
      } catch (error) {
        try {
          const names = await this.run(
            resource.kind === "container"
              ? ["ps", "-a", "--format", "{{.Names}}"]
              : ["network", "ls", "--format", "{{.Name}}"],
          );
          if (names.split("\n").includes(resource.name)) failures.push(error);
        } catch (check) {
          failures.push(
            new AggregateError(
              [error, check],
              `Could not verify removal of ${resource.name}`,
            ),
          );
        }
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Owned HA fixture cleanup failed");
    this.resources.length = 0;
  }
}
export function pinned(image: string): void {
  if (!/^[^\s]+@sha256:[0-9a-f]{64}$/.test(image))
    throw new Error("Fixture images require immutable SHA-256 digests");
}
