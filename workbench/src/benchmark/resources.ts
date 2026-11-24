import { Worker } from "node:worker_threads";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { stat } from "node:fs/promises";
import type { ResourceReading } from "./resource-readings.js";
export { cpuSeconds } from "./resource-readings.js";

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

/** Probes run in a worker; only the sender's event-loop histogram stays here. */
export async function startResources(servicePid: number) {
  if (!Number.isSafeInteger(servicePid) || servicePid < 1)
    throw new Error("Invalid service PID for resource sampler");
  const loop = monitorEventLoopDelay({ resolution: 10 });
  const samples: unknown[] = [];
  const source = import.meta.url.endsWith(".ts");
  const worker = new Worker(
    new URL(
      source ? "./resource-worker.ts" : "./resource-worker.js",
      import.meta.url,
    ),
    {
      execArgv: source ? ["--import", "tsx"] : [],
      workerData: {
        clientPid: process.pid,
        servicePid,
        origin: performance.timeOrigin,
      },
    },
  );
  loop.enable();
  let failure: Error | undefined;
  let stopping = false;
  let finish: Promise<unknown[]> | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (cause: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const fail = (cause: Error) => {
    failure ??= cause;
    rejectReady(cause);
  };
  worker.on("error", fail);
  worker.on(
    "message",
    (message: { reading?: ResourceReading; error?: string }) => {
      if (message.error) {
        fail(new Error(message.error));
        return;
      }
      if (!message.reading) {
        fail(new Error("Invalid resource worker message"));
        return;
      }
      samples.push({
        ...message.reading,
        clientEventLoop: {
          samples: loop.count,
          meanMs: loop.count ? loop.mean / 1e6 : null,
          p99Ms: loop.count ? loop.percentile(99) / 1e6 : null,
          maxMs: loop.count ? loop.max / 1e6 : null,
        },
      });
      loop.reset();
      resolveReady();
    },
  );
  const exited = new Promise<void>((resolve) =>
    worker.once("exit", (code) => {
      if (!stopping || code !== 0)
        fail(new Error(`Resource worker exited unexpectedly (${code})`));
      loop.disable();
      resolve();
    }),
  );
  const stop = () =>
    (finish ??= (async () => {
      stopping = true;
      worker.postMessage("stop");
      const deadline = setTimeout(() => {
        fail(new Error("Resource worker shutdown deadline exceeded"));
        void worker.terminate();
      }, 5000);
      try {
        await exited;
      } finally {
        clearTimeout(deadline);
        loop.disable();
      }
      if (failure) throw failure;
      return samples;
    })());
  const startup = setTimeout(
    () => fail(new Error("Resource worker startup deadline exceeded")),
    5000,
  );
  try {
    await ready;
  } catch (cause) {
    await stop().catch(() => {});
    throw cause;
  } finally {
    clearTimeout(startup);
  }
  return { stop };
}
