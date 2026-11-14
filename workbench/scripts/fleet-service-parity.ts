/** Ordinary transport qualification; never prepares or builds Java artifacts. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import WebSocket from "ws";
import { unzipSync } from "fflate";
import { startZooGlassSession } from "../src/service/zooglass-session.js";
import {
  buildDocument,
  configurationWire,
  events,
  frame,
  receipt,
  states,
  subscriptions,
  updates,
  checkpoints,
} from "../scenarios/timeline-fleet/author.js";

type StateName = keyof typeof states;
const hash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function httpSnapshot(name: StateName) {
  const { type: _type, ...snapshot } = frame(name);
  void _type;
  return snapshot;
}

/** Event-driven socket barrier with bounded cancellation and raw wire retention. */
class ObservedSocket {
  readonly socket: WebSocket;
  readonly raw: string[] = [];
  readonly sent: string[] = [];
  readonly messages: unknown[] = [];
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (bytes) => {
      const raw = bytes.toString();
      this.raw.push(raw);
      try {
        this.messages.push(JSON.parse(raw));
      } catch {
        this.messages.push(raw);
      }
    });
    this.socket.on("error", () => {});
  }
  async wait(predicate: () => boolean, signal: AbortSignal, label: string) {
    signal.throwIfAborted();
    if (predicate()) return;
    await new Promise<void>((done, fail) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.socket
          .off("message", check)
          .off("open", check)
          .off("close", closed)
          .off("error", failed);
        signal.removeEventListener("abort", aborted);
      };
      const failed = (error: unknown) => {
        cleanup();
        fail(error);
      };
      const check = () => {
        try {
          if (predicate()) {
            cleanup();
            done();
          }
        } catch (error) {
          failed(error);
        }
      };
      const closed = () =>
        failed(new Error(`Socket closed waiting for ${label}`));
      const aborted = () => failed(signal.reason);
      const timer = setTimeout(
        () => failed(new Error(`Timed out waiting for ${label}`)),
        5000,
      );
      this.socket
        .on("message", check)
        .on("open", check)
        .on("close", closed)
        .on("error", failed);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      else check();
    });
  }
  send(body: unknown) {
    const raw = JSON.stringify(body);
    this.sent.push(raw);
    this.socket.send(raw);
  }
}

export async function runFleetServiceParity(
  folder: string,
  serviceDirectory: string,
  qualification = false,
) {
  const directory = resolve(folder);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      encoding: "utf8",
      cwd: fileURLToPath(new URL("../", import.meta.url)),
    }).trim();
  const sourceRevision = git("rev-parse", "HEAD");
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
    ).length > 0;
  const sourceDirty = dirty();
  if (qualification && sourceDirty)
    throw new Error("Qualification requires a clean committed checkout");
  const jar = join(resolve(serviceDirectory), "target", "zooglass.jar");
  const artifact = await readFile(jar);
  const entries = unzipSync(artifact, {
    filter: (entry) =>
      entry.name === "META-INF/MANIFEST.MF" ||
      entry.name.startsWith("BOOT-INF/classes/io/zooglass/"),
  });
  assert.match(
    Buffer.from(entries["META-INF/MANIFEST.MF"]).toString(),
    /Start-Class: io\.zooglass\.ZooGlassApplication/,
  );
  const coreClasses = Object.entries(entries)
    .filter(([name]) => name.startsWith("BOOT-INF/classes/io/zooglass/"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, bytes]) => ({ name, sha256: hash(bytes) }));
  const coreArtifactPath = join(
    resolve(serviceDirectory),
    "target",
    "zooglass-runtime.jar",
  );
  const coreArtifact = await readFile(coreArtifactPath);
  const coreEntries = unzipSync(coreArtifact, {
    filter: (entry) =>
      entry.name.startsWith("io/zooglass/") && entry.name.endsWith(".class"),
  });
  assert.ok(
    Object.keys(coreEntries).length > 0,
    "Prepared core artifact must contain runtime classes",
  );
  for (const [name, bytes] of Object.entries(coreEntries)) {
    assert.equal(
      hash(entries[`BOOT-INF/classes/${name}`]),
      hash(bytes),
      `Service/core class mismatch: ${name}`,
    );
  }
  const provenancePaths = [
    fileURLToPath(import.meta.url),
    fileURLToPath(
      new URL("../scenarios/timeline-fleet/author.ts", import.meta.url),
    ),
    fileURLToPath(
      new URL("../src/service/zooglass-session.ts", import.meta.url),
    ),
    fileURLToPath(new URL("../package-lock.json", import.meta.url)),
    jar,
    coreArtifactPath,
  ];
  const provenance = async () =>
    Object.fromEntries(
      await Promise.all(
        provenancePaths.map(async (path) => [path, hash(await readFile(path))]),
      ),
    );
  const before = await provenance();
  const runtimePath = fileURLToPath(
    new URL("../scenarios/timeline-fleet/runtime.json", import.meta.url),
  );
  const config = await readFile(runtimePath, "utf8");
  assert.equal(config, configurationWire);
  await mkdir(directory);
  await writeFile(join(directory, "runtime.json"), config);
  const document = buildDocument();
  await writeFile(
    join(directory, "inputs.json"),
    JSON.stringify(
      {
        publications: document.publications,
        subscriptions: document.actions.filter(
          (a) => a.kind === "client-subscribe",
        ),
        checkpoints,
      },
      null,
      2,
    ),
  );
  const evidence = {
    format: "fleet-service-parity/v1",
    sourceRevision,
    sourceDirty,
    qualification,
    serviceArtifact: {
      path: jar,
      sha256: hash(artifact),
      classesSha256: hash(JSON.stringify(coreClasses)),
      classes: coreClasses,
    },
    coreArtifact: {
      path: coreArtifactPath,
      sha256: hash(coreArtifact),
      matchedServiceClasses: Object.keys(coreEntries).length,
    },
    provenanceBefore: before,
    provenanceAfter: {} as Record<string, string>,
    configurationSha256: hash(config),
    runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    authorSha256: hash(
      await readFile(
        new URL("../scenarios/timeline-fleet/author.ts", import.meta.url),
      ),
    ),
    limits: { watchdogMs: 90000, socketBarrierMs: 5000 },
    http: [] as unknown[],
    sourceReceipts: {} as Record<string, string[]>,
    sent: {} as Record<string, string[]>,
    clientFrames: [] as string[],
    checkedCheckpoints: [] as unknown[],
    passed: false,
    error: undefined as string | undefined,
    boundary:
      "Per-source receipts and authored HTTP/client states; no wall-clock timing or cross-socket frame-order determinism claim.",
  };
  const sockets: ObservedSocket[] = [];
  let session: Awaited<ReturnType<typeof startZooGlassSession>> | undefined;
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(new Error("Parity interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const signal = AbortSignal.any([
    cancellation.signal,
    AbortSignal.timeout(90000),
  ]);
  try {
    session = await startZooGlassSession({
      serviceDirectory: resolve(serviceDirectory),
      runtimeConfigurationPath: join(directory, "runtime.json"),
      signal,
    });
    const liveSignal = AbortSignal.any([signal, session.signal]);
    const connect = async (path: string) => {
      const connection = new ObservedSocket(
        session!.baseUrl.replace("http:", "ws:") + path,
      );
      sockets.push(connection);
      await connection.wait(
        () => connection.socket.readyState === WebSocket.OPEN,
        liveSignal,
        "connection",
      );
      return connection;
    };
    const client = await connect("/views/live");
    evidence.clientFrames = client.raw;
    evidence.sent.client = client.sent;
    const sources = new Map<string, ObservedSocket>();
    for (const source of document.actors.filter((a) => a.role === "source")) {
      const connection = await connect("/events");
      sources.set(source.id, connection);
      evidence.sourceReceipts[source.id] = connection.raw;
      evidence.sent[source.id] = connection.sent;
    }
    const current = new Map<string, StateName>();
    const key = (name: StateName) =>
      `${states[name].view}/${states[name].entity}`;
    const checkState = async (name: StateName, at: number) => {
      const url = `${session!.baseUrl}/views/${states[name].view}/${states[name].entity}`;
      const response = await fetch(url, {
        signal: AbortSignal.any([liveSignal, AbortSignal.timeout(5000)]),
      });
      const raw = await response.text();
      evidence.http.push({ at, name, url, status: response.status, raw });
      assert.equal(response.status, 200);
      assert.deepEqual(
        JSON.parse(raw),
        httpSnapshot(name),
        `HTTP ${at}/${name}`,
      );
      await client.wait(
        () => client.messages.some((m) => isDeepStrictEqual(m, frame(name))),
        liveSignal,
        `client state ${at}/${name}`,
      );
    };
    for (const [at, name] of subscriptions) {
      client.send({
        action: "subscribe",
        viewId: states[name].view,
        entityId: states[name].entity,
      });
      await client.wait(
        () =>
          client.messages.some((m) =>
            isDeepStrictEqual(m, {
              type: "subscribed",
              viewId: states[name].view,
              entityId: states[name].entity,
              recovery: "freshSnapshot",
            }),
          ),
        liveSignal,
        `subscription ${name}`,
      );
      await checkState(name, at);
      current.set(key(name), name);
    }
    for (let index = 0; index < events.length; index++) {
      const event = events[index],
        source = sources.get(event.source)!;
      source.send(document.publications[index].body);
      const expected = events
        .slice(0, index + 1)
        .filter((e) => e.source === event.source)
        .map(receipt);
      await source.wait(
        () => source.messages.length >= expected.length,
        liveSignal,
        `receipt ${event.at}`,
      );
      assert.deepEqual(
        source.messages,
        expected,
        `source receipts through ${event.at}`,
      );
      for (const [at, name] of updates)
        if (at === event.at) current.set(key(name), name);
      for (const name of current.values()) await checkState(name, event.at);
      const nextAt = events[index + 1]?.at ?? Infinity;
      for (const checkpoint of checkpoints.filter(
        ([at]) => at > event.at && at < nextAt,
      )) {
        await checkState(checkpoint[2], checkpoint[0]);
        evidence.checkedCheckpoints.push(checkpoint);
      }
    }
    assert.equal(evidence.checkedCheckpoints.length, 20);
    // A protocol acknowledgement on this output socket follows the state gates.
    // Compare complete per-subscription streams without imposing global wire order.
    for (const [, name] of subscriptions) {
      client.send({
        action: "unsubscribe",
        viewId: states[name].view,
        entityId: states[name].entity,
      });
      await client.wait(
        () =>
          client.messages.some((m: unknown) => {
            const value = m as Record<string, unknown>;
            return (
              value.type === "unsubscribed" &&
              value.viewId === states[name].view &&
              value.entityId === states[name].entity
            );
          }),
        liveSignal,
        `unsubscribe ${name}`,
      );
      const actual = client.messages.filter((m: unknown) => {
        const value = m as Record<string, unknown>;
        return (
          value.type === "view-update" &&
          value.viewId === states[name].view &&
          value.entityId === states[name].entity
        );
      });
      assert.deepEqual(actual, [
        frame(name),
        ...updates
          .filter(([, update]) => key(update) === key(name))
          .map(([, update]) => frame(update)),
      ]);
    }
    assert.equal(
      client.messages.length,
      34,
      "28 authored frames plus six unsubscribe barriers",
    );
    for (const [source, connection] of sources)
      assert.deepEqual(
        connection.messages,
        events.filter((event) => event.source === source).map(receipt),
        `Final source receipts ${source}`,
      );
    evidence.provenanceAfter = await provenance();
    assert.deepEqual(
      evidence.provenanceAfter,
      before,
      "Artifact/runner provenance changed during parity run",
    );
    assert.equal(await readFile(runtimePath, "utf8"), config);
    assert.equal(
      await readFile(join(directory, "runtime.json"), "utf8"),
      config,
    );
    assert.equal(git("rev-parse", "HEAD"), sourceRevision);
    if (qualification) assert.equal(dirty(), false);
    evidence.passed = true;
  } catch (error) {
    evidence.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    for (const connection of sockets) connection.socket.terminate();
    try {
      await session?.close().catch((error: unknown) => {
        evidence.passed = false;
        evidence.error = String(error);
        throw error;
      });
    } finally {
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
      "Usage: fleet-service-parity NEW_DIRECTORY [SERVICE_DIRECTORY] [smoke|qualification]",
    );
  await runFleetServiceParity(folder, service, mode === "qualification");
  console.log(`Fleet ordinary-service parity passed: ${resolve(folder)}`);
}
