import { parentPort, workerData } from "node:worker_threads";
import { collectResources } from "./resource-readings.js";

if (!parentPort) throw new Error("Resource collector requires a worker thread");
const port = parentPort;
const { clientPid, servicePid, origin } = workerData as {
  clientPid: number;
  servicePid: number;
  origin: number;
};
let stopping = false;
let timer: NodeJS.Timeout | undefined;
let pending: Promise<void>;
let count = 0;

// Finish the in-flight bounded probes; never leave an overlapping sample behind.
port.on("message", (message: unknown) => {
  if (message !== "stop") return;
  stopping = true;
  clearTimeout(timer);
  void pending.finally(() => port.close());
});
async function sample() {
  const started = performance.now();
  try {
    if (++count > 3600) throw new Error("Resource sample limit exceeded");
    const reading = await collectResources(clientPid, servicePid, origin);
    port.postMessage({ reading });
    if (!stopping)
      timer = setTimeout(
        () => {
          pending = sample();
        },
        Math.max(0, 1000 - (performance.now() - started)),
      );
  } catch (cause) {
    stopping = true;
    port.postMessage({ error: String(cause) });
    port.close();
  }
}
pending = sample();
