/** Bounded ordinary Order parity using prepared service artifacts only. */
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
import { sourceIds } from "../scenarios/timeline-order/inputs.js";
import {
  exclusions,
  expectedReceipt,
  expectedState,
  initialSteps,
  projectReceipt,
  projectState,
  selectedSends,
  sends,
  watermark,
  watermarkReceipt,
  type PublicState,
} from "./order-parity-oracle.js";

const views = ["order-summary", "order-tracking"];
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

export async function runOrderServiceParity(
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
  const runtimePath = join(workbench, "scenarios/timeline-order/runtime.json");
  const configuration = await readFile(runtimePath);
  assert.equal(
    hash(configuration),
    "d3398885305dc27c409ad3cea3f9035d7c024e572ee2ee16354421a74fad1a33",
    "Exact accepted Order configuration",
  );
  const paths = [
    jar,
    core,
    runtimePath,
    "scripts/order-service-parity.ts",
    "scripts/order-parity-oracle.ts",
    "scripts/service-parity-socket.ts",
    "src/service/zooglass-session.ts",
    "src/service/runtime-configuration.ts",
    "src/service/protected-session.ts",
    "scenarios/timeline-order/inputs.ts",
    "scenarios/timeline-order/order-one.ts",
    "scenarios/timeline-order/observations.ts",
    "scenarios/timeline-order/receipts.ts",
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
        publications: selectedSends.map((id) => ({
          id,
          body: sends[id].body,
          expectedReceipt: expectedReceipt(id),
        })),
        watermark,
        watermarkReceipt,
        exclusions,
        initialSteps,
        expectedStates: Object.fromEntries(
          [
            "empty",
            ...initialSteps.map(([, name]) => name),
            "paymentGap",
            "paymentFour",
            "confirmedGap",
            "expired",
            "refreshedInventory",
            "refreshedPrimary",
          ].map((name) => [
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
    format: "order-service-parity/v1",
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
    interrupt = () => cancellation.abort(new Error("Order parity interrupted"));
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
    storeDirectory = await mkdtemp(join(tmpdir(), "order-service-parity-"));
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
      control = await connect("progress", "/progress");
    const sources = new Map<string, ObservedSocket>();
    for (const source of sourceIds)
      sources.set(source, await connect(source, "/events"));
    const read = async (view: string, barrier: string) => {
      const response = await fetch(
        `${session!.baseUrl}/views/${view}/order-1`,
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
    const latestClient = (view: string) =>
      client.messages.findLast((message) => {
        const value = message as Partial<PublicState> | null;
        return (
          value?.type === "view-update" &&
          value.viewId === view &&
          value.entityId === "order-1"
        );
      }) as PublicState | undefined;
    const check = async (name: string, barrier = name) => {
      const observed: Record<string, PublicState> = {};
      for (const view of views) {
        const snapshot = await read(view, barrier);
        observed[view] = snapshot;
        assert.deepEqual(
          projectState(snapshot),
          expectedState(name, view),
          `${barrier}: HTTP ${view}`,
        );
        await client.wait(
          () => {
            const value = latestClient(view);
            return (
              value !== undefined &&
              isDeepStrictEqual(projectState(value), expectedState(name, view))
            );
          },
          live,
          `${barrier}: client ${view}`,
        );
      }
      evidence.barriers.push(barrier);
      return observed;
    };
    for (const view of views) {
      client.send({ action: "subscribe", viewId: view, entityId: "order-1" });
      await client.wait(
        () =>
          client.messages.some((message) =>
            isDeepStrictEqual(message, {
              type: "subscribed",
              viewId: view,
              entityId: "order-1",
              recovery: "freshSnapshot",
            }),
          ),
        live,
        `subscribe ${view}`,
      );
    }
    await check("empty");
    const actualReceipts = new Map<
      string,
      { version: number; [key: string]: unknown }
    >();
    const publish = async (id: string) => {
      const source = sources.get(sends[id].body.sourceId)!,
        count = source.messages.length;
      source.send(sends[id].body);
      await source.wait(
        () => source.messages.length > count,
        live,
        `receipt ${id}`,
      );
      assert.equal(source.messages.length, count + 1);
      const result = source.messages[count] as {
        version: number;
        [key: string]: unknown;
      };
      assert.deepEqual(
        projectReceipt(result),
        expectedReceipt(id),
        `receipt ${id}`,
      );
      assert.ok(Number.isSafeInteger(result.version) && result.version > 0);
      actualReceipts.set(id, result);
      return result;
    };
    for (const [id, name] of initialSteps) {
      await publish(id);
      await check(name, id);
    }
    assert.equal(
      actualReceipts.get("p7-0")!.version,
      actualReceipts.get("p4-0")!.version,
      "Duplicate retains original committed version",
    );
    await publish("p9-0");
    await check("paymentGap");
    await publish("p26-0");
    await check("paymentFour");
    control.send(watermark.control);
    await control.wait(
      () => control.messages.length === 1,
      live,
      "watermark receipt",
    );
    assert.deepEqual(
      projectReceipt(control.messages[0] as Record<string, unknown>),
      watermarkReceipt,
    );
    await check("confirmedGap");
    await publish("p35-0");
    const fresh = await check("confirmedGap", "unmapped-payment");
    for (const view of views)
      for (const field of ["delivery", "inventory"]) {
        const at = fresh[view].status.fields[field].receivedAtMillis;
        assert.ok(typeof at === "number" && Number.isSafeInteger(at) && at > 0);
        evidence.deadlines[`${view}/${field}`] = at + 15000;
        assert.ok(
          Date.now() < at + 15000,
          "Setup must finish before actual expiry",
        );
      }
    // Waiting approaches observed real deadlines; only observed state establishes expiry.
    await delay(
      Math.max(
        0,
        Math.max(...Object.values(evidence.deadlines)) - Date.now() - 100,
      ),
      undefined,
      { signal: live },
    );
    // No HTTP or source/control traffic during this wait: reads can themselves
    // expire fields and would conceal a missing production alarm.
    const clientTimes = evidence.connections.find(
      (connection) => connection.name === "client",
    )!.receivedAt;
    for (const view of views) {
      await client.wait(
        () => {
          const value = latestClient(view);
          return (
            value !== undefined &&
            isDeepStrictEqual(
              projectState(value),
              expectedState("expired", view),
            )
          );
        },
        live,
        `spontaneous expiry ${view}`,
      );
      for (const field of ["delivery", "inventory"]) {
        const index = client.messages.findIndex((message) => {
          const value = message as PublicState | null;
          return (
            value?.type === "view-update" &&
            value.viewId === view &&
            value.entityId === "order-1" &&
            value.status.fields[field].freshness === "stale"
          );
        });
        assert.ok(index >= 0, `Spontaneous stale frame ${view}/${field}`);
        const observed = client.messages[index] as PublicState;
        assert.equal(
          observed.status.fields[field].receivedAtMillis,
          fresh[view].status.fields[field].receivedAtMillis,
          "Expiry cannot refresh receipt sample",
        );
        const deadline = evidence.deadlines[`${view}/${field}`],
          observedAt = clientTimes[index];
        assert.ok(observedAt >= deadline, "No early expiry");
        assert.ok(
          observedAt <= deadline + 5000,
          "Expiry frame within bounded deadline tolerance",
        );
        evidence.expiryFrames.push({
          view,
          field,
          index,
          observedAt,
          deadline,
        });
      }
    }
    await check("expired");
    sources.get("courier-primary")!.socket.terminate();
    sources.set(
      "courier-primary",
      await connect("courier-primary-reconnected", "/events"),
    );
    const unchanged = async (barrier: string) => {
      const observed = await check("expired", barrier);
      for (const view of views)
        for (const field of ["delivery", "inventory"])
          assert.equal(
            observed[view].status.fields[field].receivedAtMillis,
            fresh[view].status.fields[field].receivedAtMillis,
            `${barrier}: unchanged receipt sample`,
          );
    };
    await unchanged("reconnect-no-refresh");
    await publish("p29-0");
    await unchanged("fresh-backup-stale-primary");
    await publish("p32-0");
    const stock = await check("refreshedInventory");
    await publish("p33-0");
    const selected = await check("refreshedPrimary");
    for (const view of views) {
      assert.ok(
        stock[view].status.fields.inventory.receivedAtMillis! >
          fresh[view].status.fields.inventory.receivedAtMillis!,
      );
      assert.equal(
        stock[view].status.fields.delivery.receivedAtMillis,
        fresh[view].status.fields.delivery.receivedAtMillis,
      );
      assert.ok(
        selected[view].status.fields.delivery.receivedAtMillis! >
          fresh[view].status.fields.delivery.receivedAtMillis!,
      );
      client.send({ action: "unsubscribe", viewId: view, entityId: "order-1" });
      await client.wait(
        () =>
          client.messages.some((message) => {
            const value = message as { type?: string; viewId?: string } | null;
            return value?.type === "unsubscribed" && value.viewId === view;
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
      "Usage: order-service-parity NEW_DIRECTORY [SERVICE_DIRECTORY] [smoke|qualification]",
    );
  await runOrderServiceParity(folder, service, mode === "qualification");
  console.log(`Order service parity passed: ${resolve(folder)}`);
}
