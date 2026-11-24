import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const exec = promisify(execFile);
const unavailable = (cause: unknown) => ({ unavailable: String(cause) });

export function cpuSeconds(value: string) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) throw new Error(`Unrecognised process CPU time: ${value}`);
  return (
    Number(match[1] ?? 0) * 86400 +
    Number(match[2] ?? 0) * 3600 +
    Number(match[3]) * 60 +
    Number(match[4])
  );
}

async function processSample(pid: number) {
  try {
    const { stdout } = await exec(
      "ps",
      ["-p", String(pid), "-o", "time=", "-o", "rss="],
      { timeout: 1500, killSignal: "SIGKILL", maxBuffer: 4096 },
    );
    const [cpu, rss] = stdout.trim().split(/\s+/);
    if (!Number.isFinite(Number(rss))) throw new Error("Invalid RSS sample");
    return { pid, cpuSeconds: cpuSeconds(cpu), rssBytes: Number(rss) * 1024 };
  } catch (cause) {
    return { pid, ...unavailable(cause) };
  }
}

async function ioSample(pid: number) {
  if (process.platform !== "linux")
    return unavailable("Process disk I/O not available on this platform");
  try {
    return Object.fromEntries(
      (await readFile(`/proc/${pid}/io`, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          const [key, value] = line.split(":");
          return [key, Number(value.trim())];
        }),
    );
  } catch (cause) {
    return unavailable(cause);
  }
}

async function heapSample(pid: number) {
  try {
    const executable = process.env.JAVA_HOME
      ? join(process.env.JAVA_HOME, "bin", "jstat")
      : "jstat";
    const { stdout } = await exec(executable, ["-gc", String(pid)], {
      timeout: 1500,
      killSignal: "SIGKILL",
      maxBuffer: 8192,
    });
    const [header, row] = stdout.trim().split("\n");
    const names = header.trim().split(/\s+/),
      values = row.trim().split(/\s+/);
    if (names.length !== values.length) throw new Error("Invalid jstat sample");
    return {
      source: "jstat -gc; sizes in KiB, times in seconds",
      values: Object.fromEntries(
        names.map((name, i) => [
          name,
          values[i] === "-" ? null : Number(values[i]),
        ]),
      ),
    };
  } catch (cause) {
    return unavailable(cause);
  }
}

export async function collectResources(
  clientPid: number,
  servicePid: number,
  origin: number,
) {
  const atMs = performance.timeOrigin + performance.now() - origin;
  const started = performance.now();
  const [client, service, clientIo, serviceIo, heap] = await Promise.all([
    processSample(clientPid),
    processSample(servicePid),
    ioSample(clientPid),
    ioSample(servicePid),
    heapSample(servicePid),
  ]);
  return {
    atMs,
    samplingMs: performance.now() - started,
    client,
    service,
    clientIo,
    serviceIo,
    heap,
  };
}
export type ResourceReading = Awaited<ReturnType<typeof collectResources>>;
