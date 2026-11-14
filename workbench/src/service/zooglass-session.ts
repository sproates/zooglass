import { spawn, execFile, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  protectedSessionConfiguration,
  type ProtectedSessionSettings,
} from "./protected-session.js";
import { runtimeConfiguration } from "./runtime-configuration.js";
import type { ScenarioSource, ScenarioView } from "../scenario/scenario.js";

export interface ZooGlassSession {
  baseUrl: string;
  /** Aborted on caller cancellation, shutdown, or unexpected service exit. */
  signal: AbortSignal;
  close(): Promise<void>;
}

export interface ZooGlassSessionOptions {
  views?: ScenarioView[];
  sources?: ScenarioSource[];
  signal?: AbortSignal;
  serviceDirectory?: string;
  /** Override the Java executable for process-ownership fixtures. */
  javaExecutable?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  protectedAccess?: ProtectedSessionSettings;
  /** Exact runtime document; mutually exclusive with generated/protected configuration. */
  runtimeConfigurationPath?: string;
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
    if (closing) {
      return closing;
    }

    controller.abort(new Error("ZooGlass session closed."));
    closing = (async () => {
      try {
        if (child?.pid !== undefined && !finished) {
          const ownedChild = child;
          const pid = child.pid;

          const terminate = async (force: boolean) => {
            if (process.platform === "win32") {
              // Windows has no POSIX process groups; terminate the JVM process tree.
              await new Promise<void>((resolve, reject) => {
                execFile(
                  "taskkill",
                  ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
                  (error) => {
                    // Some console processes refuse non-forced taskkill.
                    // Still allow the grace period and forced fallback.
                    if (error && force && !finished) {
                      reject(error);
                    } else {
                      resolve();
                    }
                  },
                );
              });
            } else {
              try {
                process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                  throw error;
                }

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

            if (result === "timeout") {
              await terminate(true);
            }

            // Wait for close, including inherited output streams, after escalation too.
            await stopped;
          } finally {
            timer.abort();
          }
        } else {
          await stopped;
        }
      } finally {
        if (configDirectory !== undefined) {
          await rm(configDirectory, { recursive: true, force: true });
        }
      }
    })();

    return closing;
  };

  try {
    signal.throwIfAborted();
    if (
      options.runtimeConfigurationPath !== undefined &&
      (options.views !== undefined ||
        options.sources !== undefined ||
        options.protectedAccess !== undefined)
    ) {
      throw new Error(
        "runtimeConfigurationPath cannot be combined with views, sources or protectedAccess.",
      );
    }
    const explicitConfiguration =
      options.runtimeConfigurationPath === undefined
        ? undefined
        : await readFile(options.runtimeConfigurationPath);

    const serviceDirectory =
      options.serviceDirectory ??
      fileURLToPath(new URL("../../../zooglass/", import.meta.url));
    const artifact = join(serviceDirectory, "target", "zooglass.jar");

    try {
      await access(artifact);
    } catch (error) {
      throw new Error(
        `ZooGlass application is not available at ${artifact}. Run npm run prepare:service from workbench before starting sessions; rebuild after Java changes.`,
        { cause: error },
      );
    }

    configDirectory = await mkdtemp(join(tmpdir(), "zooglass-workbench-"));
    const portFile = join(configDirectory, "service.port");
    let configLocation: string | undefined;

    if (explicitConfiguration !== undefined) {
      const configPath = join(configDirectory, "runtime.json");
      await writeFile(configPath, explicitConfiguration);
      configLocation = pathToFileURL(configPath).href;
    } else if (options.views !== undefined) {
      const configPath = join(configDirectory, "views.json");

      await writeFile(
        configPath,
        JSON.stringify(runtimeConfiguration(options.views, options.sources)),
      );
      configLocation = pathToFileURL(configPath).href;
    }

    signal.throwIfAborted();

    const java =
      options.javaExecutable ??
      (process.env.JAVA_HOME
        ? join(
            process.env.JAVA_HOME,
            "bin",
            process.platform === "win32" ? "java.exe" : "java",
          )
        : "java");
    const protectedAccess = options.protectedAccess;
    const args = [
      ...(protectedAccess
        ? [
            `-Djavax.net.ssl.trustStore=${protectedAccess.trustStore}`,
            `-Djavax.net.ssl.trustStorePassword=${protectedAccess.trustStorePassword}`,
          ]
        : []),
      `-DPORTFILE=${portFile}`,
      "-jar",
      artifact,
      "--server.address=127.0.0.1",
      "--server.port=0",
      "--zooglass.report-port=true",
    ];

    const startedChild = spawn(java, args, {
      cwd: serviceDirectory,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        ...(protectedAccess
          ? {
              SPRING_APPLICATION_JSON: JSON.stringify(
                protectedSessionConfiguration(protectedAccess),
              ),
            }
          : {}),
        ...(configLocation === undefined
          ? {}
          : { ZOOGLASS_CONFIG: configLocation }),
      },
    });
    child = startedChild;
    stopped = new Promise((resolve) => {
      startedChild.once("error", (error) => controller.abort(error));
      startedChild.once("exit", (code, terminationSignal) => {
        controller.abort(
          new Error(
            `ZooGlass exited with ${terminationSignal ?? `code ${code}`}.`,
          ),
        );
      });
      startedChild.once("close", (code, terminationSignal) => {
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

    let baseUrl: string | undefined;
    const timeoutMs = options.startupTimeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      signal.throwIfAborted();

      try {
        if (!baseUrl) {
          const port = Number(await readFile(portFile, "utf8"));
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error("Waiting for ZooGlass to report its bound port.");
          }
          baseUrl = protectedAccess
            ? `https://localhost:${port}`
            : `http://127.0.0.1:${port}`;
        }
        const healthUrl = protectedAccess
          ? `http://127.0.0.1:${protectedAccess.operatorPort}/actuator/health`
          : `${baseUrl}/actuator/health`;
        const response = await fetch(healthUrl, {
          ...(protectedAccess
            ? {
                headers: {
                  Authorization: `Bearer ${protectedAccess.operatorToken}`,
                },
              }
            : {}),
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
