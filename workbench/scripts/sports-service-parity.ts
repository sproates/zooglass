/** Bounded ordinary Sports parity using prepared service artifacts only. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { unzipSync } from "fflate";
import WebSocket from "ws";
import { startZooGlassSession } from "../src/service/zooglass-session.js";
import { ObservedSocket } from "./service-parity-socket.js";
import {
  exclusions,
  expectedReceipt,
  expectedState,
  projectReceipt,
  projectState,
  publications,
  rows,
  sourceIds,
  views,
  watermark,
  watermarkReceipt,
  retirement,
  retirementReceipt,
  type PublicState,
  type PublicationName,
  type StateName,
} from "./sports-parity-oracle.js";

const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const workbench = fileURLToPath(new URL("../", import.meta.url));
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: workbench, encoding: "utf8" }).trim();
const dirty = () =>
  git("status", "--porcelain", "--untracked-files=no").length > 0 ||
  git(
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "scripts",
    "src",
    "scenarios",
    "package.json",
    "package-lock.json",
    "../zooglass",
  ).length > 0;

export async function runSportsServiceParity(
  folder: string,
  serviceDirectory: string,
  qualification = false,
) {
  const directory = resolve(folder),
    service = resolve(serviceDirectory);
  const revision = git("rev-parse", "HEAD"),
    sourceDirty = dirty();
  if (qualification && sourceDirty)
    throw new Error("Qualification requires a clean committed checkout");
  const jar = join(service, "target", "zooglass.jar"),
    core = join(service, "target", "zooglass-runtime.jar");
  const artifact = await readFile(jar),
    coreArtifact = await readFile(core);
  const entries = unzipSync(artifact, {
    filter: (entry) =>
      entry.name === "META-INF/MANIFEST.MF" ||
      entry.name.startsWith("BOOT-INF/classes/io/zooglass/"),
  });
  assert.match(
    Buffer.from(entries["META-INF/MANIFEST.MF"]).toString(),
    /Start-Class: io\.zooglass\.ZooGlassApplication/,
  );
  const coreEntries = unzipSync(coreArtifact, {
    filter: (entry) =>
      entry.name.startsWith("io/zooglass/") && entry.name.endsWith(".class"),
  });
  assert.ok(Object.keys(coreEntries).length > 0);
  for (const [name, bytes] of Object.entries(coreEntries))
    assert.equal(
      hash(entries[`BOOT-INF/classes/${name}`]),
      hash(bytes),
      `Service/core mismatch: ${name}`,
    );
  const runtimePath = join(
    workbench,
    "../zooglass/simulation-host/src/test/resources/sports-runtime.json",
  );
  const configuration = await readFile(runtimePath);
  assert.equal(
    hash(configuration),
    "775781cbf4e64abfb9a4a7ea1c61f8e7f904d3e743f5e8e660bec536e9e367ae",
    "Exact accepted Sports configuration",
  );
  const paths = [
    jar,
    core,
    runtimePath,
    "scripts/sports-service-parity.ts",
    "scripts/sports-parity-oracle.ts",
    "scripts/service-parity-socket.ts",
    "src/service/zooglass-session.ts",
    "src/service/runtime-configuration.ts",
    "src/service/protected-session.ts",
    "package-lock.json",
  ].map((path) => resolve(workbench, path));
  const provenance = async () =>
    Object.fromEntries(
      await Promise.all(
        paths.map(async (path) => [path, hash(await readFile(path))]),
      ),
    );
  const before = await provenance();
  await mkdir(directory);
  await writeFile(join(directory, "runtime.json"), configuration);
  await writeFile(
    join(directory, "inputs.json"),
    JSON.stringify(
      {
        publications,
        watermark,
        watermarkReceipt,
        retirement: views.map((view) => ({
          control: retirement(view),
          expected: retirementReceipt(view),
        })),
        exclusions,
        expectedStates: Object.fromEntries(
          (Object.keys(rows) as StateName[]).map((name) => [
            name,
            Object.fromEntries(
              views.map((view) => [view, expectedState(name, view)]),
            ),
          ]),
        ),
      },
      null,
      2,
    ),
  );
  const evidence = {
    format: "sports-service-parity/v1",
    revision,
    sourceDirty,
    qualification,
    artifacts: {
      service: hash(artifact),
      core: hash(coreArtifact),
      matchedCoreClasses: Object.keys(coreEntries).length,
    },
    configurationSha256: hash(configuration),
    provenanceBefore: before,
    provenanceAfter: {} as Record<string, string>,
    exclusions,
    limits: {
      watchdogMillis: 35000,
      freshnessMillis: 15000,
      socketBarrierMillis: 5000,
    },
    connections: [] as {
      name: string;
      sent: string[];
      received: string[];
      receivedAt: number[];
    }[],
    http: [] as {
      barrier: string;
      view: string;
      observedAt: number;
      status: number;
      raw: string;
    }[],
    barriers: [] as string[],
    deadlines: {} as Record<string, number>,
    expiryFrames: [] as {
      view: string;
      field: string;
      index: number;
      observedAt: number;
      deadline: number;
    }[],
    passed: false,
    error: undefined as string | undefined,
  };
  const cancellation = new AbortController(),
    interrupt = () =>
      cancellation.abort(new Error("Sports parity interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const signal = AbortSignal.any([
    cancellation.signal,
    AbortSignal.timeout(35000),
  ]);
  const sockets: ObservedSocket[] = [];
  let session: Awaited<ReturnType<typeof startZooGlassSession>> | undefined;
  let storeDirectory: string | undefined;
  try {
    storeDirectory = await mkdtemp(join(tmpdir(), "sports-service-parity-"));
    session = await startZooGlassSession({
      serviceDirectory: service,
      runtimeConfigurationPath: join(directory, "runtime.json"),
      databasePath: join(storeDirectory, "state.sqlite"),
      signal,
      startupTimeoutMs: 10000,
    });
    const live = AbortSignal.any([signal, session.signal]);
    const connect = async (name: string, path: string) => {
      const socket = new ObservedSocket(
        session!.baseUrl.replace("http:", "ws:") + path,
      );
      sockets.push(socket);
      const receivedAt: number[] = [];
      socket.socket.on("message", () => receivedAt.push(Date.now()));
      evidence.connections.push({
        name,
        sent: socket.sent,
        received: socket.raw,
        receivedAt,
      });
      await socket.wait(
        () => socket.socket.readyState === WebSocket.OPEN,
        live,
        `open ${name}`,
      );
      return socket;
    };
    const client = await connect("client", "/views/live"),
      progress = await connect("progress", "/progress"),
      retire = await connect("retirement", "/facts/retire");
    const sources = new Map<string, ObservedSocket>();
    for (const source of sourceIds)
      sources.set(source, await connect(source, "/events"));
    const read = async (view: string, barrier: string) => {
      const response = await fetch(
        `${session!.baseUrl}/views/${view}/match-1`,
        { signal: AbortSignal.any([live, AbortSignal.timeout(3000)]) },
      );
      const raw = await response.text();
      evidence.http.push({
        barrier,
        view,
        observedAt: Date.now(),
        status: response.status,
        raw,
      });
      assert.equal(response.status, 200);
      return JSON.parse(raw) as PublicState;
    };
    const latest = (view: string) =>
      client.messages.findLast((message) => {
        const value = message as Partial<PublicState> | null;
        return (
          value?.type === "view-update" &&
          value.viewId === view &&
          value.entityId === "match-1"
        );
      }) as PublicState | undefined;
    const check = async (name: StateName, barrier: string = name) => {
      const observed: Record<string, PublicState> = {};
      for (const view of views) {
        const value = await read(view, barrier);
        observed[view] = value;
        assert.deepEqual(
          projectState(value),
          expectedState(name, view),
          `${barrier}: HTTP ${view}`,
        );
        await client.wait(
          () => {
            const current = latest(view);
            return (
              current !== undefined &&
              isDeepStrictEqual(
                projectState(current),
                expectedState(name, view),
              )
            );
          },
          live,
          `${barrier}: client ${view}`,
        );
      }
      evidence.barriers.push(barrier);
      return observed;
    };
    const exchange = async (
      socket: ObservedSocket,
      body: object,
      expected: object,
      label: string,
    ) => {
      const count = socket.messages.length;
      socket.send(body);
      await socket.wait(() => socket.messages.length > count, live, label);
      assert.equal(socket.messages.length, count + 1);
      const received = socket.messages[count] as Record<string, unknown>;
      assert.deepEqual(projectReceipt(received), expected, label);
      assert.ok(
        Number.isSafeInteger(received.version) && Number(received.version) >= 0,
      );
      return received;
    };
    const publish = (
      name: PublicationName,
      mode: Parameters<typeof expectedReceipt>[1] = "ordinary",
    ) =>
      exchange(
        sources.get(publications[name].sourceId)!,
        publications[name],
        expectedReceipt(name, mode),
        `${name}/${mode}`,
      );
    const retirementControl = (
      view: (typeof views)[number],
      status = "committed",
    ) =>
      exchange(
        retire,
        retirement(view, status === "rejected"),
        retirementReceipt(view, status),
        `retire ${view}/${status}`,
      );
    for (const view of views) {
      client.send({ action: "subscribe", viewId: view, entityId: "match-1" });
      await client.wait(
        () =>
          client.messages.some((message) =>
            isDeepStrictEqual(message, {
              type: "subscribed",
              viewId: view,
              entityId: "match-1",
              recovery: "freshSnapshot",
            }),
          ),
        live,
        `subscribe ${view}`,
      );
    }
    await check("empty");
    await publish("match");
    await check("match");
    await publish("marketOne");
    await check("marketOne");
    await publish("homeBaseline");
    await check("homeBaseline");
    const baseline = await publish("awayBaseline");
    await check("awayBaseline");
    const unknown = await publish("correction", "unknown");
    assert.equal(
      unknown.version,
      baseline.version,
      "Unknown fact consumes no global version",
    );
    await check("awayBaseline", "unknown-before-create");
    const goal = await publish("goal");
    await check("goal");
    await publish("correction");
    await check("corrected");
    await publish("withdrawal");
    await check("withdrawn");
    await publish("marketThree");
    await check("marketGap");
    await exchange(
      progress,
      watermark,
      watermarkReceipt,
      "bookmaker watermark",
    );
    await check("watermark");
    const retired = await retirementControl("match-market");
    await check("marketRetired");
    const rejected = await retirementControl("scoreboard", "rejected");
    assert.equal(
      rejected.version,
      retired.version,
      "Partial control failure commits nothing",
    );
    await check("marketRetired", "partial-retirement-failure");
    const equal = await retirementControl("match-market", "unchanged");
    assert.equal(
      equal.version,
      retired.version,
      "Equal floor returns current version without a new commit",
    );
    await check("marketRetired", "equal-floor");
    await retirementControl("scoreboard");
    await check("scoreboardRetired");
    await retirementControl("first-reported");
    await check("allRetired");
    const duplicate = await publish("goal", "duplicate");
    assert.equal(
      duplicate.version,
      goal.version,
      "Retained duplicate preserves original committed version",
    );
    await check("allRetired", "duplicate-after-retirement");
    await publish("outside", "outside");
    await check("outside");
    await publish("newBaseline");
    const fresh = await check("newBaseline");
    const sample = fresh["match-market"].status.fields.market.receivedAtMillis;
    assert.ok(
      typeof sample === "number" && Number.isSafeInteger(sample) && sample > 0,
    );
    const deadline = sample + 15000;
    evidence.deadlines["match-market/market"] = deadline;
    assert.ok(
      Date.now() < deadline,
      "Setup must finish before actual market expiry",
    );
    // No HTTP, source or control traffic while waiting: only the production alarm
    // may cause the spontaneous stale client observation.
    await delay(Math.max(0, deadline - Date.now() - 100), undefined, {
      signal: live,
    });
    await client.wait(
      () => {
        const value = latest("match-market");
        return (
          value !== undefined &&
          isDeepStrictEqual(
            projectState(value),
            expectedState("expired", "match-market"),
          )
        );
      },
      live,
      "spontaneous market expiry",
    );
    const index = client.messages.findIndex((message) => {
      const value = message as PublicState | null;
      return (
        value?.type === "view-update" &&
        value.viewId === "match-market" &&
        value.status.fields.market.freshness === "stale"
      );
    });
    assert.ok(index >= 0);
    const expired = client.messages[index] as PublicState;
    assert.equal(
      expired.status.fields.market.receivedAtMillis,
      sample,
      "Expiry does not refresh receipt sample",
    );
    const observedAt = evidence.connections.find(
      (connection) => connection.name === "client",
    )!.receivedAt[index];
    assert.ok(
      observedAt >= deadline && observedAt <= deadline + 5000,
      "Spontaneous expiry within real deadline tolerance",
    );
    evidence.expiryFrames.push({
      view: "match-market",
      field: "market",
      index,
      observedAt,
      deadline,
    });
    await check("expired");
    sources.get("bookmaker")!.socket.terminate();
    sources.set("bookmaker", await connect("bookmaker-reconnected", "/events"));
    const reconnected = await check("expired", "reconnect-no-refresh");
    assert.equal(
      reconnected["match-market"].status.fields.market.receivedAtMillis,
      sample,
    );
    await publish("marketFour");
    const refreshed = await check("refreshed");
    assert.ok(
      refreshed["match-market"].status.fields.market.receivedAtMillis! > sample,
      "Accepted market update refreshes sample",
    );
    for (const view of views) {
      client.send({ action: "unsubscribe", viewId: view, entityId: "match-1" });
      await client.wait(
        () =>
          client.messages.some((message) => {
            const value = message as {
              type?: string;
              viewId?: string;
              entityId?: string;
            } | null;
            return (
              value?.type === "unsubscribed" &&
              value.viewId === view &&
              value.entityId === "match-1"
            );
          }),
        live,
        `unsubscribe ${view}`,
      );
    }
    evidence.provenanceAfter = await provenance();
    assert.deepEqual(evidence.provenanceAfter, before);
    assert.equal(
      hash(await readFile(join(directory, "runtime.json"))),
      hash(configuration),
    );
    assert.equal(git("rev-parse", "HEAD"), revision);
    if (qualification) assert.equal(dirty(), false);
    evidence.passed = true;
  } catch (error) {
    evidence.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    for (const socket of sockets) socket.socket.terminate();
    try {
      await session?.close().catch((error: unknown) => {
        evidence.passed = false;
        evidence.error = String(error);
        throw error;
      });
    } finally {
      if (storeDirectory)
        await rm(storeDirectory, { recursive: true, force: true });
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      await writeFile(
        join(directory, "evidence.json"),
        JSON.stringify(evidence, null, 2) + "\n",
      );
    }
  }
  return evidence;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [folder, service = "../zooglass", mode = "smoke"] =
    process.argv.slice(2);
  if (!folder || !["smoke", "qualification"].includes(mode))
    throw new Error(
      "Usage: sports-service-parity NEW_DIRECTORY [SERVICE_DIRECTORY] [smoke|qualification]",
    );
  await runSportsServiceParity(folder, service, mode === "qualification");
  console.log(`Sports service parity passed: ${resolve(folder)}`);
}
