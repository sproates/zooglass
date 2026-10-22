import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { formatTraceEntry, playScenario, type TraceEntry } from "./playback.js";
import { loadScenario, type Scenario } from "./scenario.js";

const connectionTimeoutMs = 10_000;
const startupTimeoutMs = 60_000;

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

function startZooGlass(port: number): ChildProcess {
  const zooGlassDirectory = resolve("../zooglass");
  const wrapper = process.platform === "win32" ? "mvnw.cmd" : "./mvnw";
  const args = [
    "--batch-mode",
    `-Dspring-boot.run.arguments=--server.port=${port}`,
    "spring-boot:run",
  ];
  if (process.env.MAVEN_REPO_LOCAL !== undefined) {
    args.unshift(`-Dmaven.repo.local=${process.env.MAVEN_REPO_LOCAL}`);
  }
  const child = spawn(wrapper, args, {
    cwd: zooGlassDirectory,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[ZooGlass] ${chunk.toString()}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[ZooGlass] ${chunk.toString()}`);
  });

  return child;
}

async function waitForZooGlass(
  port: number,
  child: ChildProcess,
): Promise<void> {
  const healthUrl = `http://127.0.0.1:${port}/actuator/health`;
  const startedAt = Date.now();

  while (Date.now() - startedAt < startupTimeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `ZooGlass exited during startup with code ${child.exitCode}.`,
      );
    }

    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // The service is not listening yet. Keep waiting until it is ready.
    }

    await delay(250);
  }

  throw new Error(
    `ZooGlass did not become healthy within ${startupTimeoutMs}ms.`,
  );
}

function connectClient(url: string): Promise<WebSocket> {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out connecting to ${url}.`));
    }, connectionTimeoutMs);

    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolveSocket(socket);
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error(`Could not connect to ${url}.`));
      },
      { once: true },
    );
  });
}

async function closeClient(socket: WebSocket | undefined): Promise<void> {
  if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
    return;
  }

  const closed = once(socket, "close");
  socket.close();
  await closed;
}

function getClientId(entry: TraceEntry): string | undefined {
  if (entry.kind === "client-initial-state" || entry.kind === "client-state") {
    return entry.clientId;
  }
  return undefined;
}

async function applyClientState(
  entry: Extract<TraceEntry, { kind: "client-initial-state" | "client-state" }>,
  url: string,
  sockets: Map<string, WebSocket>,
): Promise<void> {
  if (entry.state === "connecting" || entry.state === "connected") {
    if (!sockets.has(entry.clientId)) {
      sockets.set(entry.clientId, await connectClient(url));
    }
    return;
  }

  const socket = sockets.get(entry.clientId);
  await closeClient(socket);
  sockets.delete(entry.clientId);
}

async function playConnectedScenario(
  scenario: Scenario,
  port: number,
): Promise<void> {
  const url = `ws://127.0.0.1:${port}/events`;
  const sourceSockets = new Map<string, WebSocket>();
  const clientSockets = new Map<string, WebSocket>();
  const trace = playScenario(scenario);
  const sourceNames = new Map(
    scenario.sources.map((source) => [source.id, source.name]),
  );

  try {
    for (const source of scenario.sources) {
      sourceSockets.set(source.id, await connectClient(url));
      console.log(`Connected source ${source.name} (${source.id})`);
    }

    const startedAt = performance.now();
    for (const entry of trace) {
      const elapsedTime = performance.now() - startedAt;
      const waitTime = entry.simulationTime - elapsedTime;
      if (waitTime > 0) {
        await delay(waitTime);
      }

      console.log(formatTraceEntry(entry));
      if (entry.kind === "source-event") {
        const socket = sourceSockets.get(entry.sourceId);
        if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
          throw new Error(
            `Source ${entry.sourceId} is not connected when its event is scheduled.`,
          );
        }

        socket.send(
          JSON.stringify({
            sourceId: entry.sourceId,
            type: entry.type,
            entityId: entry.entityId,
            payload: entry.payload,
          }),
        );
      } else {
        const clientId = getClientId(entry);
        if (clientId === undefined) {
          throw new Error("Could not identify client in scenario trace entry.");
        }
        await applyClientState(entry, url, clientSockets);
      }
    }
  } finally {
    await Promise.all([
      ...[...sourceSockets.values()].map(closeClient),
      ...[...clientSockets.values()].map(closeClient),
    ]);
  }

  console.log(
    `Finished scenario. Events were sent from ${sourceNames.size} source connection(s).`,
  );
}

async function stopZooGlass(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timeout = delay(5_000).then(() => "timeout" as const);
  const result = await Promise.race([exited, timeout]);
  if (result === "timeout") {
    child.kill("SIGKILL");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    throw new Error("Usage: npm run integrate -- [scenario.json]");
  }

  const scenarioPath = resolve(args[0] ?? "scenarios/live-match.json");
  const scenario = await loadScenario(scenarioPath);
  const port = await getPort();
  const child = startZooGlass(port);

  try {
    await waitForZooGlass(port, child);
    console.log(`ZooGlass is ready at http://127.0.0.1:${port}`);
    console.log(`Scenario: ${scenario.name}`);
    await playConnectedScenario(scenario, port);
  } finally {
    await stopZooGlass(child);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Connected scenario could not be played: ${message}`);
  process.exitCode = 1;
});
