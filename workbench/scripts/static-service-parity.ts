/** Two reviewed static cases over ordinary sockets and HTTP; never builds artifacts. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { unzipSync } from "fflate";
import WebSocket from "ws";
import { startZooGlassSession } from "../src/service/zooglass-session.js";
import {
  connectClient,
  closeClient,
  closeAll,
} from "../src/execution/sockets.js";
import { publishAndCheckReceipt } from "../src/execution/publication-receipt.js";
import { parseTimelineDocument } from "../src/timeline/contract.js";
import { loadConversionProvenance } from "../src/timeline/conversion-provenance.js";
import { workbenchIdentity } from "../src/timeline/manifest.js";
import { ObservedSocket } from "./service-parity-socket.js";
import {
  staticParityCases,
  staticParityPlan,
  checkStaticServiceObservations,
  checkStaticServiceEvidence,
  paritySources,
  type CaseName,
  type Provenance,
} from "./static-service-observations.js";
export {
  staticParityPlan,
  checkStaticServiceObservations,
  checkStaticServiceEvidence,
} from "./static-service-observations.js";

const workbench = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: workbench, encoding: "utf8" }).trim();
const dirty = () =>
  git("status", "--porcelain", "--untracked-files=no").length > 0 ||
  git(
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "src",
    "scripts",
    "scenarios",
    "test",
    "package.json",
    "package-lock.json",
    "../zooglass",
  ).length > 0;

export async function runStaticServiceParity(
  folder: string,
  caseName: CaseName,
  serviceDirectory = "../zooglass",
  qualification = false,
) {
  assert.ok(
    staticParityCases.includes(caseName),
    "Expected a reviewed static parity case",
  );
  const directory = resolve(folder),
    service = resolve(serviceDirectory);
  const fixture = join(workbench, "scenarios/timeline-static", caseName);
  const scenarioPath = join(fixture, "scenario.json");
  const scenario = await readFile(scenarioPath, "utf8");
  const parsed = parseTimelineDocument(scenario);
  const configurationName =
    caseName === "mixed-modes" ? "runtime.json" : "configuration.json";
  assert.equal(
    JSON.parse(parsed.canonical).runtime.configuration,
    configurationName,
  );
  const configurationPath = join(fixture, configurationName);
  const configuration = await readFile(configurationPath, "utf8");
  const plan = staticParityPlan(scenario, configuration);
  const conversion = await loadConversionProvenance(
    scenarioPath,
    parsed,
    configuration,
  );
  const revision = git("rev-parse", "HEAD"),
    sourceDirty = dirty();
  assert.ok(
    !qualification || !sourceDirty,
    "Qualification requires a clean committed checkout",
  );
  const jar = join(service, "target/zooglass.jar"),
    core = join(service, "target/zooglass-runtime.jar");
  const artifact = await readFile(jar),
    coreArtifact = await readFile(core);
  const entries = unzipSync(artifact, {
    filter: (e) =>
      e.name === "META-INF/MANIFEST.MF" ||
      e.name.startsWith("BOOT-INF/classes/io/zooglass/"),
  });
  assert.match(
    Buffer.from(entries["META-INF/MANIFEST.MF"]).toString(),
    /Start-Class: io\.zooglass\.ZooGlassApplication/,
  );
  const classes = unzipSync(coreArtifact, {
    filter: (e) =>
      e.name.startsWith("io/zooglass/") && e.name.endsWith(".class"),
  });
  assert.ok(Object.keys(classes).length > 0);
  for (const [name, bytes] of Object.entries(classes))
    assert.equal(
      hash(entries[`BOOT-INF/classes/${name}`]),
      hash(bytes),
      `Service/core mismatch: ${name}`,
    );
  const provenance = async (): Promise<Provenance> => ({
    workbench: await workbenchIdentity(),
    files: Object.fromEntries(
      await Promise.all(
        paritySources.map(async (p) => [
          p,
          hash(await readFile(join(workbench, p))),
        ]),
      ),
    ),
    service: hash(await readFile(jar)),
    core: hash(await readFile(core)),
    scenario: hash(await readFile(scenarioPath)),
    configuration: hash(await readFile(configurationPath)),
    ...(conversion
      ? {
          legacy: hash(await readFile(join(fixture, "legacy.json"))),
          conversionReport: hash(
            await readFile(join(fixture, "conversion-report.json")),
          ),
        }
      : {}),
  });
  const before = await provenance();
  assert.equal(before.scenario, hash(scenario));
  assert.equal(before.configuration, hash(configuration));
  if (conversion) {
    assert.equal(before.legacy, hash(conversion.legacy));
    assert.equal(before.conversionReport, hash(conversion.report));
  }
  await mkdir(directory);
  await writeFile(join(directory, "scenario.json"), scenario);
  await writeFile(join(directory, configurationName), configuration);
  await writeFile(
    join(directory, "inputs.json"),
    JSON.stringify(plan, null, 2) + "\n",
  );
  if (conversion) {
    await writeFile(join(directory, "legacy.json"), conversion.legacy);
    await writeFile(
      join(directory, "conversion-report.json"),
      conversion.report,
    );
  }
  const evidence = {
    format: "static-service-parity/v1",
    case: caseName,
    revision,
    sourceDirty,
    qualification,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    provenanceBefore: before,
    provenanceAfter: {} as typeof before,
    matchedCoreClasses: Object.keys(classes).length,
    comparison:
      "Receipt identity/acceptance and literal public data at serial barriers; virtual times are labels, not real-time schedules. Full internal snapshots, full receipt equality, client frame counts/order and clock/version metadata are not compared.",
    limits: {
      watchdogMillis: 30000,
      httpMillis: 3000,
      socketBarrierMillis: 5000,
    },
    connections: [] as {
      actor: string;
      endpoint: string;
      received: string[];
    }[],
    http: [] as {
      barrier: string;
      observedAt: number;
      status: number;
      raw: string;
    }[],
    accepted: [] as { send: string; actor: string; receipt: unknown }[],
    clientChecks: [] as { barrier: string; actor: string; frame: number }[],
    barriers: [] as string[],
    complete: false,
    passed: false,
    errors: [] as string[],
  };
  const cancellation = new AbortController();
  const interrupt = () =>
    cancellation.abort(new Error("Static parity interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const signal = AbortSignal.any([
    cancellation.signal,
    AbortSignal.timeout(30000),
  ]);
  const sourceSockets = new Map<string, globalThis.WebSocket>();
  const clients = new Map<string, ObservedSocket>();
  let session: Awaited<ReturnType<typeof startZooGlassSession>> | undefined;
  try {
    session = await startZooGlassSession({
      serviceDirectory: service,
      runtimeConfigurationPath: join(directory, configurationName),
      signal,
      startupTimeoutMs: 10000,
    });
    const live = AbortSignal.any([signal, session.signal]);
    const url = session.baseUrl.replace("http:", "ws:");
    for (const actor of plan.actors) {
      if (actor.role === "source") {
        const socket = await connectClient(url + "/events", live);
        sourceSockets.set(actor.id, socket);
        const received: string[] = [];
        socket.addEventListener("message", (event) =>
          received.push(String(event.data)),
        );
        evidence.connections.push({
          actor: actor.id,
          endpoint: "/events",
          received,
        });
      } else {
        const socket = new ObservedSocket(url + "/views/live");
        clients.set(actor.id, socket);
        evidence.connections.push({
          actor: actor.id,
          endpoint: "/views/live",
          received: socket.raw,
        });
        await socket.wait(
          () => socket.socket.readyState === WebSocket.OPEN,
          live,
          `open ${actor.id}`,
        );
      }
    }
    for (const subscription of plan.subscriptions) {
      const client = clients.get(subscription.actor)!;
      client.send({
        action: "subscribe",
        viewId: subscription.viewId,
        entityId: subscription.entityId,
      });
      await client.wait(
        () =>
          client.messages.some((m) =>
            isDeepStrictEqual(m, {
              type: "subscribed",
              viewId: subscription.viewId,
              entityId: subscription.entityId,
              recovery: "freshSnapshot",
            }),
          ),
        live,
        subscription.id,
      );
    }
    for (const step of plan.steps) {
      if (step.kind === "send") {
        const { sourceEntityId, ...publication } = step.body;
        const receipt = await publishAndCheckReceipt(
          sourceSockets.get(step.actor)!,
          { ...publication, entityId: sourceEntityId },
          live,
        );
        evidence.accepted.push({ send: step.id, actor: step.actor, receipt });
      } else {
        const requestUrl: URL = new URL("/views", session.baseUrl);
        requestUrl.searchParams.set("viewId", step.viewId);
        requestUrl.searchParams.set("entityId", step.entityId);
        const response: Response = await fetch(requestUrl, {
          signal: AbortSignal.any([live, AbortSignal.timeout(3000)]),
        });
        const raw = await response.text();
        evidence.http.push({
          barrier: step.id,
          observedAt: Date.now(),
          status: response.status,
          raw,
        });
        assert.equal(response.status, 200, `${step.id}: HTTP status`);
        const snapshot = JSON.parse(raw);
        assert.equal(snapshot.viewId, step.viewId);
        assert.equal(snapshot.entityId, step.entityId);
        assert.deepEqual(snapshot.data, step.expected, `${step.id}: HTTP data`);
        for (const subscription of plan.subscriptions.filter(
          (s) => s.viewId === step.viewId && s.entityId === step.entityId,
        )) {
          const client = clients.get(subscription.actor)!;
          await client.wait(
            () => {
              const latest = client.messages.findLast(
                (m) =>
                  (m as { type?: string; viewId?: string; entityId?: string })
                    ?.type === "view-update" &&
                  (m as { viewId?: string }).viewId === step.viewId &&
                  (m as { entityId?: string }).entityId === step.entityId,
              ) as { data: unknown } | undefined;
              return (
                latest !== undefined &&
                isDeepStrictEqual(latest.data, step.expected)
              );
            },
            live,
            `${step.id}: client data`,
          );
          evidence.clientChecks.push({
            barrier: step.id,
            actor: subscription.actor,
            frame: client.messages.findLastIndex(
              (m) =>
                (m as { type?: string; viewId?: string; entityId?: string })
                  ?.type === "view-update" &&
                (m as { viewId?: string }).viewId === step.viewId &&
                (m as { entityId?: string }).entityId === step.entityId,
            ),
          });
        }
        evidence.barriers.push(step.id);
      }
    }
    for (const [actor] of sourceSockets)
      assert.equal(
        evidence.connections.find((c) => c.actor === actor)!.received.length,
        evidence.accepted.filter((r) => r.actor === actor).length,
        "Exactly one receipt per send",
      );
  } catch (error) {
    evidence.errors.push(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  } finally {
    for (const client of clients.values()) client.socket.terminate();
    try {
      await closeAll(
        [...sourceSockets.values()]
          .map(closeClient)
          .concat(session ? [session.close()] : []),
      );
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
        "Source/artifact identities changed during parity",
      );
      assert.equal(git("rev-parse", "HEAD"), revision);
      assert.ok(
        !qualification || !dirty(),
        "Qualification checkout became dirty",
      );
      assert.equal(
        hash(await readFile(join(directory, configurationName))),
        before.configuration,
        "Retained configuration changed",
      );
      assert.equal(
        hash(await readFile(join(directory, "scenario.json"))),
        before.scenario,
        "Retained scenario changed",
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(directory, "inputs.json"), "utf8")),
        plan,
        "Retained barriers changed",
      );
      if (conversion) {
        assert.equal(
          hash(await readFile(join(directory, "legacy.json"))),
          before.legacy,
        );
        assert.equal(
          hash(await readFile(join(directory, "conversion-report.json"))),
          before.conversionReport,
        );
      }
      checkStaticServiceObservations(scenario, configuration, evidence);
    } catch (error) {
      evidence.errors.push(String(error));
    }
    evidence.complete = evidence.errors.length === 0;
    evidence.passed = evidence.complete;
    if (qualification && evidence.complete) {
      try {
        checkStaticServiceEvidence(evidence, scenario, configuration);
      } catch (error) {
        evidence.errors.push(String(error));
        evidence.complete = false;
        evidence.passed = false;
      }
    }
    await writeFile(
      join(directory, "evidence.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
  }
  assert.ok(evidence.passed, evidence.errors.join("\n"));
  return evidence;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [caseName, folder, service = "../zooglass", mode = "smoke", ...extra] =
    process.argv.slice(2);
  assert.ok(
    folder &&
      staticParityCases.includes(caseName as CaseName) &&
      ["smoke", "qualification"].includes(mode) &&
      !extra.length,
    "Usage: static-service-parity late-update|mixed-modes NEW_DIRECTORY [SERVICE_DIRECTORY] [smoke|qualification]",
  );
  await runStaticServiceParity(
    folder,
    caseName as CaseName,
    service,
    mode === "qualification",
  );
  console.log(`Static service parity passed: ${resolve(folder)}`);
}
