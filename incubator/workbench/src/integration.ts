import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
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

function startZooGlass(port: number, configLocation?: string): ChildProcess {
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
    env: {
      ...process.env,
      ...(configLocation === undefined
        ? {}
        : { ZOOGLASS_VIEWS_CONFIG: configLocation }),
    },
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[ZooGlass] ${chunk.toString()}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[ZooGlass] ${chunk.toString()}`);
  });

  return child;
}

async function checkView(
  port: number,
  check: Extract<TraceEntry, { kind: "view-check" }>,
): Promise<void> {
  const url = `http://127.0.0.1:${port}/views/${encodeURIComponent(check.viewId)}/${encodeURIComponent(check.entityId)}`;
  const startedAt = Date.now();
  let lastActual: unknown = "view not found";

  while (Date.now() - startedAt < 5_000) {
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    } catch (error) {
      lastActual = error instanceof Error ? error.message : String(error);
      await delay(25);
      continue;
    }

    if (check.expected === null) {
      if (response.status === 404) {
        console.log(
          `View absence check passed: ${check.viewId} (${check.entityId})`,
        );
        return;
      }
      if (response.ok) {
        throw new Error(
          `Expected view ${check.viewId} (${check.entityId}) to be absent, but it was present.`,
        );
      }
      lastActual = `HTTP ${response.status}`;
    } else if (response.ok) {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null && "data" in body) {
        lastActual = body.data;
        if (isDeepStrictEqual(body.data, check.expected)) {
          console.log(`View check passed: ${check.viewId} (${check.entityId})`);
          return;
        }
      }
    } else {
      lastActual = `HTTP ${response.status}`;
    }

    await delay(25);
  }

  throw new Error(
    `View check failed for ${check.viewId} (${check.entityId}). Expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(lastActual)}.`,
  );
}

async function defineView(
  port: number,
  entry: Extract<TraceEntry, { kind: "view-definition" }>,
): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/views`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: entry.id, fields: entry.fields }),
    signal: AbortSignal.timeout(1_000),
  });

  if (response.status !== 201) {
    throw new Error(
      `Could not define view ${entry.id}: ZooGlass returned HTTP ${response.status}.`,
    );
  }
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
  fastPlayback: boolean,
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
      if (!fastPlayback) {
        const elapsedTime = performance.now() - startedAt;
        const waitTime = entry.simulationTime - elapsedTime;
        if (waitTime > 0) {
          await delay(waitTime);
        }
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
      } else if (entry.kind === "view-check") {
        await checkView(port, entry);
      } else if (entry.kind === "view-definition") {
        await defineView(port, entry);
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
  const fastPlayback = args.includes("--fast");
  const scenarioPaths = args.filter((argument) => argument !== "--fast");
  if (scenarioPaths.some((path) => path.startsWith("--"))) {
    throw new Error("Usage: npm run integrate -- [--fast] [scenario.json ...]");
  }
  if (scenarioPaths.length === 0) {
    scenarioPaths.push("scenarios/live-match.json");
  }

  const scenarios = await Promise.all(
    scenarioPaths.map(async (path, index) =>
      namespaceScenario(await loadScenario(resolve(path)), index),
    ),
  );
  const port = await getPort();
  const views = scenarios.flatMap((scenario) => scenario.views);
  const configDirectory =
    views.length === 0
      ? undefined
      : await mkdtemp(join(tmpdir(), "zooglass-workbench-"));
  const configPath =
    configDirectory === undefined
      ? undefined
      : join(configDirectory, "views.json");

  if (configPath !== undefined) {
    await writeFile(configPath, JSON.stringify({ views }));
  }

  const child = startZooGlass(
    port,
    configPath === undefined ? undefined : pathToFileURL(configPath).href,
  );

  try {
    await waitForZooGlass(port, child);
    console.log(`ZooGlass is ready at http://127.0.0.1:${port}`);
    for (const scenario of scenarios) {
      console.log(`Scenario: ${scenario.name}`);
      await playConnectedScenario(scenario, port, fastPlayback);
    }
  } finally {
    await stopZooGlass(child);
    if (configDirectory !== undefined) {
      await rm(configDirectory, { recursive: true, force: true });
    }
  }
}

function namespaceScenario(scenario: Scenario, index: number): Scenario {
  const namespace = `scenario-${index + 1}`;
  const sourceIds = new Map(
    scenario.sources.map((source) => [source.id, `${namespace}-${source.id}`]),
  );
  const allViews = [
    ...scenario.views,
    ...scenario.timeline.filter(
      (entry): entry is Extract<TraceEntry, { kind: "view-definition" }> =>
        entry.kind === "view-definition",
    ),
  ];
  const viewIds = new Map(
    allViews.map((view) => [view.id, `${namespace}-${view.id}`]),
  );
  const namespaceView = <T extends Scenario["views"][number]>(view: T): T =>
    ({
      ...view,
      id: viewIds.get(view.id)!,
      fields: Object.fromEntries(
        Object.entries(view.fields).map(([name, matchers]) => [
          name,
          matchers.map((matcher) => ({
            ...matcher,
            sourceId: sourceIds.get(matcher.sourceId)!,
          })),
        ]),
      ),
    }) as T;

  return {
    ...scenario,
    sources: scenario.sources.map((source) => ({
      ...source,
      id: sourceIds.get(source.id)!,
    })),
    views: scenario.views.map(namespaceView),
    timeline: scenario.timeline.map((entry) => {
      if (entry.kind === "source-event") {
        return { ...entry, sourceId: sourceIds.get(entry.sourceId)! };
      }
      if (entry.kind === "view-check") {
        return { ...entry, viewId: viewIds.get(entry.viewId)! };
      }
      if (entry.kind === "view-definition") {
        return namespaceView(entry);
      }
      return entry;
    }),
  };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Connected scenario could not be played: ${message}`);
  process.exitCode = 1;
});
