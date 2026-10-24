import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { ScenarioView } from "./scenario.js";

export interface ZooGlassSession {
  baseUrl: string;
  /** Aborted on caller cancellation, shutdown, or unexpected service exit. */
  signal: AbortSignal;
  close(): Promise<void>;
}

export interface ZooGlassSessionOptions {
  views?: ScenarioView[];
  signal?: AbortSignal;
  serviceDirectory?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}
function getPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local port for ZooGlass."));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolvePort(address.port);
        }
      });
    });
  });
}

/** Start one owned service. A failed start cleans up before rejecting. */
export async function startZooGlassSession(
  options: ZooGlassSessionOptions = {},
): Promise<ZooGlassSession> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  let configDirectory: string | undefined;
  let child: ChildProcess | undefined;
  let stopped: Promise<void> = Promise.resolve();
  let finished = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    controller.abort(new Error("ZooGlass session closed."));
    closing = (async () => {
      try {
        if (child?.pid !== undefined && !finished) {
          const ownedChild = child;
          const pid = child.pid;
          const terminate = async (force: boolean) => {
            if (process.platform === "win32") {
              // Windows has no POSIX process groups; terminate the Maven/JVM tree.
              await new Promise<void>((resolve, reject) => {
                execFile(
                  "taskkill",
                  ["/PID", String(pid), "/T", "/F"],
                  (error) => {
                    if (error && !finished) reject(error);
                    else resolve();
                  },
                );
              });
            } else {
              try {
                process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH")
                  throw error;
                ownedChild.kill(force ? "SIGKILL" : "SIGTERM");
              }
            }
          };
          await terminate(false);
          const timer = new AbortController();
          try {
            const result = await Promise.race([
              stopped.then(() => "stopped"),
              delay(options.shutdownTimeoutMs ?? 5_000, "timeout", {
                signal: timer.signal,
              }),
            ]);
            if (result === "timeout") await terminate(true);
            // Wait for close, including inherited output streams, after escalation too.
            await stopped;
          } finally {
            timer.abort();
          }
        } else {
          await stopped;
        }
      } finally {
        if (configDirectory !== undefined)
          await rm(configDirectory, { recursive: true, force: true });
      }
    })();
    return closing;
  };
  try {
    signal.throwIfAborted();
    const port = await getPort();
    let configLocation: string | undefined;
    if (options.views?.length) {
      configDirectory = await mkdtemp(join(tmpdir(), "zooglass-workbench-"));
      const configPath = join(configDirectory, "views.json");
      await writeFile(configPath, JSON.stringify({ views: options.views }));
      configLocation = pathToFileURL(configPath).href;
    }
    signal.throwIfAborted();
    const bootArguments = `-Dspring-boot.run.arguments=--server.address=127.0.0.1 --server.port=${port}`;
    const args = [
      "--batch-mode",
      process.platform === "win32" ? `"${bootArguments}"` : bootArguments,
      "spring-boot:run",
    ];
    if (process.env.MAVEN_REPO_LOCAL !== undefined)
      args.unshift(`-Dmaven.repo.local=${process.env.MAVEN_REPO_LOCAL}`);
    child = spawn(process.platform === "win32" ? "mvnw.cmd" : "./mvnw", args, {
      cwd:
        options.serviceDirectory ??
        fileURLToPath(new URL("../../zooglass/", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        ...(configLocation === undefined
          ? {}
          : { ZOOGLASS_VIEWS_CONFIG: configLocation }),
      },
    });
    stopped = new Promise((resolve) => {
      child!.once("error", (error) => controller.abort(error));
      child!.once("exit", (code, terminationSignal) => {
        controller.abort(
          new Error(
            `ZooGlass exited with ${terminationSignal ?? `code ${code}`}.`,
          ),
        );
      });
      child!.once("close", (code, terminationSignal) => {
        finished = true;
        controller.abort(
          new Error(
            `ZooGlass exited with ${terminationSignal ?? `code ${code}`}.`,
          ),
        );
        resolve();
      });
    });
    child.stdout?.on("data", (chunk: Buffer) =>
      process.stdout.write(`[ZooGlass] ${chunk.toString()}`),
    );
    child.stderr?.on("data", (chunk: Buffer) =>
      process.stderr.write(`[ZooGlass] ${chunk.toString()}`),
    );
    const baseUrl = `http://127.0.0.1:${port}`;
    const timeoutMs = options.startupTimeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      try {
        const response = await fetch(`${baseUrl}/actuator/health`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
        });
        if (response.ok) {
          signal.throwIfAborted();
          return { baseUrl, signal, close };
        }
      } catch {
        signal.throwIfAborted();
      }
      await delay(250, undefined, { signal });
    }
    throw new Error(`ZooGlass did not become healthy within ${timeoutMs}ms.`);
  } catch (error) {
    await close();
    throw error;
  }
}
