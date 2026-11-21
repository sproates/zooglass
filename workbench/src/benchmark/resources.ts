import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { readFile, stat } from "node:fs/promises";
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
      { timeout: 1500, maxBuffer: 4096 },
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

export async function storeSizes(databasePath: string | undefined) {
  if (!databasePath)
    return { unavailable: "Memory runtime has no database files" };
  const result: Record<string, number> = {};
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      result[suffix || "database"] = (await stat(databasePath + suffix)).size;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT")
        result[suffix || "database"] = 0;
      else throw cause;
    }
  }
  return result;
}

/** Best-effort external sampling; unavailability never turns into an invented metric. */
export function startResources(servicePid: number) {
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const samples: unknown[] = [];
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let pending: Promise<void> = Promise.resolve();
  const sample = async () => {
    const atMs = performance.now();
    const [client, service, clientIo, serviceIo, heap] = await Promise.all([
      processSample(process.pid),
      processSample(servicePid),
      ioSample(process.pid),
      ioSample(servicePid),
      heapSample(servicePid),
    ]);
    samples.push({
      atMs,
      samplingMs: performance.now() - atMs,
      client,
      service,
      clientIo,
      serviceIo,
      heap,
      clientEventLoop: {
        samples: loop.count,
        meanMs: loop.count ? loop.mean / 1e6 : null,
        p99Ms: loop.count ? loop.percentile(99) / 1e6 : null,
        maxMs: loop.count ? loop.max / 1e6 : null,
      },
    });
    loop.reset();
    if (!stopped)
      timer = setTimeout(
        () => {
          pending = sample();
        },
        Math.max(0, 1000 - (performance.now() - atMs)),
      );
  };
  pending = sample();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await pending;
      loop.disable();
      return samples;
    },
  };
}
