/** M1/S1 over ordinary service interfaces. Prepared artifacts only; no Java builds. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import WebSocket from "ws";
import {
  startZooGlassSession,
  type ZooGlassSession,
} from "../src/service/zooglass-session.js";
import {
  connectClient,
  closeClient,
  closeAll,
} from "../src/execution/sockets.js";
import { publishAndCheckReceipt } from "../src/execution/publication-receipt.js";
import { workbenchIdentity } from "../src/timeline/manifest.js";
import { ObservedSocket } from "./service-parity-socket.js";
import { jarEntry, jarInventory, readJar } from "./control-evidence.js";
import {
  cleanRecoverySource,
  digest,
  git,
  workbench,
  writeEvidence,
} from "./recovery-evidence.js";
import {
  recoveryParityCases,
  recoveryParitySources,
  recoveryServicePlan,
  checkRecoveryServiceObservations,
  checkRecoveryServiceEvidence,
  type RecoveryParityCase,
  type RecoveryServiceEvidence,
  type RecoveryServiceProvenance,
} from "./recovery-service-observations.js";
export {
  recoveryServicePlan,
  checkRecoveryServiceObservations,
  checkRecoveryServiceEvidence,
} from "./recovery-service-observations.js";

export async function runRecoveryServiceParity(
  folder: string,
  name: RecoveryParityCase,
  serviceDirectory = "../zooglass",
  qualification = false,
) {
  assert.ok(recoveryParityCases.includes(name));
  const directory = resolve(folder),
    service = resolve(serviceDirectory);
  const fixture = join(workbench, "scenarios/timeline-static-recovery", name);
  const scenario = await readFile(join(fixture, "scenario.json"), "utf8");
  const configuration = await readFile(join(fixture, "runtime.json"), "utf8");
  const plan = recoveryServicePlan(name, scenario, configuration);
  const source = qualification ? await cleanRecoverySource() : null;
  const revision = git("rev-parse", "HEAD");
  const jar = join(service, "target/zooglass.jar"),
    core = join(service, "target/zooglass-runtime.jar");
  const serviceBytes = await readJar(jar),
    coreBytes = await readJar(core);
  const serviceEntries = await jarInventory(serviceBytes),
    coreEntries = await jarInventory(coreBytes);
  assert.match(
    (await jarEntry(serviceBytes, "META-INF/MANIFEST.MF")).toString(),
    /Start-Class: io\.zooglass\.ZooGlassApplication/,
  );
  const classes = [...coreEntries].filter(
    ([path]) => path.startsWith("io/zooglass/") && path.endsWith(".class"),
  );
  assert.ok(classes.length > 0);
  for (const [path, hash] of classes)
    assert.equal(
      serviceEntries.get(`BOOT-INF/classes/${path}`),
      hash,
      `Service/core mismatch: ${path}`,
    );
  const provenance = async (): Promise<RecoveryServiceProvenance> => ({
    workbench: await workbenchIdentity(),
    files: Object.fromEntries(
      await Promise.all(
        recoveryParitySources.map(async (path) => [
          path,
          digest(await readFile(join(workbench, path))),
        ]),
      ),
    ),
    service: digest(await readJar(jar)),
    core: digest(await readJar(core)),
    scenario: digest(await readFile(join(fixture, "scenario.json"))),
    configuration: digest(await readFile(join(fixture, "runtime.json"))),
  });
  const before = await provenance();
  assert.equal(before.service, digest(serviceBytes));
  assert.equal(before.core, digest(coreBytes));
  assert.equal(before.scenario, digest(scenario));
  assert.equal(before.configuration, digest(configuration));
  await mkdir(directory); // Never replace an existing evidence directory.
  await writeEvidence(join(directory, "plan.json"), plan);
  // Exact bytes, including whitespace, remain the service's configuration input.
  await writeFile(join(directory, "scenario.json"), scenario, { flag: "wx" });
  await writeFile(join(directory, "runtime.json"), configuration, {
    flag: "wx",
  });
  const evidence: RecoveryServiceEvidence & {
    environment: object;
    comparison: string;
  } = {
    format: "recovery-service-parity/v1",
    case: name,
    source,
    revision,
    qualification,
    complete: false,
    passed: false,
    errors: [],
    matchedCoreClasses: classes.length,
    provenanceBefore: before,
    provenanceAfter: before,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    comparison:
      "Exact input bytes, full literal receipts, public data and public snapshots at serial barriers, including the new connection's reconnect baseline. Virtual times label barriers; socket trace timing/count equality and internal contribution-envelope equality are not claimed. Both service generations must close without forced termination.",
    connections: [],
    receipts: [],
    http: [],
    clientChecks: [],
    lifecycle: [],
    completedSteps: [],
  };
  const cancellation = new AbortController();
  const interrupt = () =>
    cancellation.abort(new Error("Recovery service comparison interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const signal = AbortSignal.any([
    cancellation.signal,
    AbortSignal.timeout(60000),
  ]);
  let scratch: string | undefined;
  let session: ZooGlassSession | undefined;
  const sources = new Map<string, globalThis.WebSocket>();
  const clients = new Map<string, ObservedSocket>();
  const connection = (id: string) => {
    const found = evidence.connections.find((c) => c.id === id);
    assert.ok(found, `Missing service connection ${id}`);
    return found;
  };
  const closeConnections = async () => {
    for (const client of clients.values()) client.socket.terminate();
    await closeAll([...sources.values()].map(closeClient));
    sources.clear();
    clients.clear();
  };
  const start = async (generation: number) => {
    assert.equal(session, undefined);
    session = await startZooGlassSession({
      serviceDirectory: service,
      runtimeConfigurationPath: join(directory, "runtime.json"),
      ...(plan.storage === "sqlite"
        ? { databasePath: join(scratch!, "runtime.sqlite") }
        : {}),
      signal,
      startupTimeoutMs: 15000,
    });
    evidence.lifecycle.push({ generation, event: "started" });
  };
  const stop = async (generation: number) => {
    assert.ok(session);
    // Attempt both cleanups even if sockets fail. A strict close rejects only after cleanup.
    await closeAll([
      closeConnections(),
      session.close({ requireOrderly: true }),
    ]);
    session = undefined;
    evidence.lifecycle.push({ generation, event: "stopped", orderly: true });
  };
  try {
    scratch = await mkdtemp(join(tmpdir(), "zooglass-recovery-service-"));
    await start(1);
    for (const step of plan.steps) {
      signal.throwIfAborted();
      if (step.kind === "stop") await stop(step.generation);
      else if (step.kind === "start") await start(step.generation);
      else {
        assert.ok(session);
        const live = AbortSignal.any([signal, session.signal]);
        if (step.kind === "connect") {
          const received: string[] = [];
          const record = {
            id: step.id,
            actor: step.actor,
            generation: step.generation,
            endpoint: step.endpoint,
            sent: [] as string[],
            received,
          };
          const url = session.baseUrl.replace("http:", "ws:") + step.endpoint;
          if (step.endpoint === "/events") {
            const socket = await connectClient(url, live);
            sources.set(step.id, socket);
            socket.addEventListener("message", (event) =>
              received.push(String(event.data)),
            );
          } else {
            const socket = new ObservedSocket(url);
            clients.set(step.id, socket);
            record.received = socket.raw;
            record.sent = socket.sent;
            await socket.wait(
              () => socket.socket.readyState === WebSocket.OPEN,
              live,
              step.id,
            );
          }
          evidence.connections.push(record);
        } else if (step.kind === "subscribe") {
          const socket = clients.get(step.connection)!;
          const cursor = socket.messages.length;
          socket.send(step.request);
          await socket.wait(
            () =>
              socket.messages
                .slice(cursor)
                .some((m) => isDeepStrictEqual(m, step.acknowledgement)) &&
              socket.messages
                .slice(cursor)
                .some((m) => isDeepStrictEqual(m, step.expected)),
            live,
            step.id,
          );
          const acknowledgement = socket.messages.findIndex(
            (m, i) => i >= cursor && isDeepStrictEqual(m, step.acknowledgement),
          );
          const frame = socket.messages.findIndex(
            (m, i) =>
              i > acknowledgement && isDeepStrictEqual(m, step.expected),
          );
          assert.ok(frame > acknowledgement);
          evidence.clientChecks.push({
            barrier: step.id,
            connection: step.connection,
            acknowledgement,
            frame,
          });
        } else if (step.kind === "publish") {
          const observed = connection(step.connection);
          const frame = observed.received.length;
          observed.sent.push(JSON.stringify(step.body));
          const { sourceEntityId, ...body } = step.body;
          const receipt = await publishAndCheckReceipt(
            sources.get(step.connection)!,
            { ...body, entityId: sourceEntityId },
            live,
          );
          evidence.receipts.push({
            action: step.id,
            connection: step.connection,
            frame,
          });
          assert.deepEqual(receipt, step.expected, `Full receipt: ${step.id}`);
        } else if (step.kind === "http") {
          const url: URL = new URL("/views", session.baseUrl);
          url.searchParams.set("viewId", step.viewId);
          url.searchParams.set("entityId", step.entityId);
          const response: Response = await fetch(url, {
            signal: AbortSignal.any([live, AbortSignal.timeout(3000)]),
          });
          const raw = await response.text();
          evidence.http.push({
            barrier: step.id,
            generation: step.generation,
            status: response.status,
            raw,
          });
          assert.equal(response.status, 200);
          const snapshot = JSON.parse(raw);
          assert.equal(snapshot.viewId, step.viewId);
          assert.equal(snapshot.entityId, step.entityId);
          assert.deepEqual(
            step.scope === "data" ? snapshot.data : snapshot,
            step.expected,
            `HTTP literal: ${step.id}`,
          );
        }
      }
      evidence.completedSteps.push(step.id);
    }
    await stop(2);
  } catch (error) {
    evidence.errors.push(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  } finally {
    try {
      await closeAll([
        closeConnections(),
        ...(session ? [session.close()] : []),
      ]);
    } catch (error) {
      evidence.errors.push(String(error));
    }
    try {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    } catch (error) {
      evidence.errors.push(String(error));
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    try {
      evidence.provenanceAfter = await provenance();
      assert.deepEqual(
        evidence.provenanceAfter,
        before,
        "Service comparison identities changed",
      );
      assert.equal(git("rev-parse", "HEAD"), revision);
      if (qualification) assert.deepEqual(await cleanRecoverySource(), source);
      assert.equal(
        await readFile(join(directory, "scenario.json"), "utf8"),
        scenario,
      );
      assert.equal(
        await readFile(join(directory, "runtime.json"), "utf8"),
        configuration,
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(directory, "plan.json"), "utf8")),
        plan,
      );
      checkRecoveryServiceObservations(name, scenario, configuration, evidence);
      evidence.complete = evidence.errors.length === 0;
      evidence.passed = evidence.complete;
      if (qualification && evidence.complete)
        checkRecoveryServiceEvidence(evidence, scenario, configuration);
    } catch (error) {
      evidence.errors.push(String(error));
      evidence.complete = false;
      evidence.passed = false;
    }
    await writeEvidence(join(directory, "evidence.json"), evidence);
  }
  assert.ok(evidence.passed, evidence.errors.join("\n"));
  return evidence;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [name, folder, service = "../zooglass", mode = "smoke", ...extra] =
    process.argv.slice(2);
  assert.ok(
    folder &&
      recoveryParityCases.includes(name as RecoveryParityCase) &&
      ["smoke", "qualification"].includes(mode) &&
      !extra.length,
    "Usage: recovery-service-parity m1|s1 NEW_DIRECTORY [SERVICE_DIRECTORY] [smoke|qualification]",
  );
  await runRecoveryServiceParity(
    folder,
    name as RecoveryParityCase,
    service,
    mode === "qualification",
  );
}
