import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, open, readFile, writeFile } from "node:fs/promises";
import https from "node:https";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Decimal } from "../../src/json/lossless.js";
import { Ownership } from "../../src/service/ha/ownership.js";
import { HaProducer } from "../../src/service/ha/producer.js";
import { NodeTransport } from "../../src/service/ha/transport.js";
import { HaViewer } from "../../src/service/ha/viewer.js";
import { type ViewerEvent } from "../../src/service/ha/viewer-state.js";
import { haTls } from "../fixtures/ha-tls.js";

/** Actual Node client against the prepared service JAR and owned PostgreSQL fixture. */
test(
  "HA client consumes real TLS baselines, updates, snapshots and durable duplicate receipts",
  { timeout: 45_000 },
  async (t) => {
    for (const name of [
      "ZOOGLASS_POSTGRES_URL",
      "ZOOGLASS_POSTGRES_USER",
      "ZOOGLASS_POSTGRES_PASSWORD",
    ]) {
      assert.ok(
        process.env[name],
        `Run through scripts/test-postgresql.py --node-client; missing ${name}`,
      );
    }
    const tls = await haTls(t);
    const jar = fileURLToPath(
      new URL("../../../zooglass/target/zooglass.jar", import.meta.url),
    );
    await access(jar); // Preparation belongs to the caller, never this test.
    const config = join(tls.directory, "runtime.json");
    const portFile = join(tls.directory, "service.port");
    await writeFile(
      config,
      JSON.stringify({
        contractVersion: 2,
        storage: "postgresql",
        maxStreams: 6,
        identityWindow: 2,
        maxHistoryEntries: 2,
        sources: [{ id: "feed", epoch: "run" }],
        views: [
          {
            id: "match",
            fields: {
              score: {
                sourceId: "feed",
                type: "updated",
                mode: "latestBySequence",
              },
            },
          },
        ],
      }),
    );
    const log = await open(join(tls.directory, "service.log"), "w");
    const java = process.env.JAVA_HOME
      ? join(process.env.JAVA_HOME, "bin/java")
      : "java";
    const probe = "ephemeral-readiness-token-32-characters";
    const child = spawn(java, [`-DPORTFILE=${portFile}`, "-jar", jar], {
      stdio: ["ignore", log.fd, log.fd],
      env: {
        ...process.env,
        SPRING_APPLICATION_JSON: JSON.stringify({
          "server.address": "127.0.0.1",
          "server.port": 0,
          "server.ssl.enabled": true,
          "server.ssl.key-store": tls.store,
          "server.ssl.key-store-password": tls.password,
          "server.forward-headers-strategy": "none",
          "zooglass.report-port": true,
          "zooglass.config": `file:${config}`,
          "zooglass.deployment.profile": "ha-static-v1",
          "zooglass.access.mode": "openDemo",
          "zooglass.ha.runtime-id": "node-interop",
          "zooglass.ha.database-url": process.env.ZOOGLASS_POSTGRES_URL,
          "zooglass.ha.database-user": process.env.ZOOGLASS_POSTGRES_USER,
          "zooglass.ha.database-password":
            process.env.ZOOGLASS_POSTGRES_PASSWORD,
          "zooglass.ha.database-ssl-mode": "disable",
          "zooglass.ha.probe-token": probe,
        }),
      },
    });
    let exited = false;
    let processError: Error | undefined;
    const closed = new Promise<void>((resolve) => {
      child.once("error", (error) => {
        processError = error;
      });
      child.once("close", () => {
        exited = true;
        resolve();
      });
    });
    t.after(async () => {
      if (!exited) child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 5000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
        await log.close();
      }
    });
    let origin = "";
    const deadline = performance.now() + 25_000;
    while (performance.now() < deadline) {
      if (exited)
        throw (
          processError ??
          new Error(`Service exited before ready (${child.exitCode})`)
        );
      try {
        const port = Number(await readFile(portFile, "utf8"));
        assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
        origin = `https://127.0.0.1:${port}`;
        const ready = await new Promise<number>((resolve, reject) => {
          const request = https.get(
            `${origin}/ha/ready`,
            {
              ca: tls.cert,
              headers: { Authorization: `Bearer ${probe}` },
              signal: AbortSignal.timeout(2500),
            },
            (response) => {
              response.resume();
              response.on("end", () => resolve(response.statusCode ?? 0));
            },
          );
          request.on("error", reject);
        });
        if (ready === 200) break;
      } catch {
        /* Port reporting and owner activation are independent startup steps. */
      }
      await delay(50);
    }
    assert.ok(
      origin && performance.now() < deadline,
      "service becomes authority-checked ready",
    );
    const transport = new NodeTransport({
      origins: [origin],
      ca: tls.cert,
      maxBytes: 16_384,
    });
    const ownership = new Ownership();
    const events: ViewerEvent[] = [];
    const updated = Promise.withResolvers<void>();
    const viewer = new HaViewer({
      origins: [origin],
      transport,
      ownership,
      maxBytes: 16_384,
      maxResources: 4,
      onEvent: (event) => {
        events.push(event);
        if (
          event.type === "snapshot" &&
          event.value.version instanceof Decimal &&
          event.value.version.text === "1"
        )
          updated.resolve();
      },
      onUnavailable: (error) => updated.reject(error),
    });
    const producer = new HaProducer({
      origins: [origin],
      transport,
      ownership,
      maxBytes: 16_384,
    });
    t.after(async () => {
      producer.close();
      await viewer.close();
    });
    await viewer.start([{ viewId: "match", entityId: "42" }]);
    const baseline = events.find((event) => event.type === "snapshot");
    assert.ok(baseline?.type === "snapshot");
    assert.equal((baseline.value.version as Decimal).text, "0");
    const bytes =
      '{"sourceId":"feed","epoch":"run","sourceEntityId":"42","publicationSequence":1,"type":"updated","payload":{"score":9007199254740993}}';
    const committed = await producer.publish(bytes);
    assert.equal(committed.status, "resolved");
    if (committed.status !== "resolved") assert.fail(committed.reason);
    assert.equal(committed.receipt.status, "committed");
    assert.equal(committed.receipt.reason, "postgresql");
    await Promise.race([
      updated.promise,
      delay(5000).then(() => {
        throw new Error("Live update missing");
      }),
    ]);
    const last = events.filter((event) => event.type === "snapshot").at(-1);
    assert.ok(last?.type === "snapshot");
    assert.equal(
      (last.value.data as Record<string, Record<string, Decimal>>).score.score
        .text,
      "9007199254740993",
    );
    const duplicate = await producer.publish(bytes);
    assert.equal(duplicate.status, "resolved");
    if (duplicate.status !== "resolved") assert.fail(duplicate.reason);
    assert.equal(duplicate.receipt.status, "duplicate");
    assert.equal((duplicate.receipt.version as Decimal).text, "1");
    const httpViewer = new HaViewer({
      origins: [origin],
      transport,
      ownership,
      maxBytes: 16_384,
      maxResources: 2,
      onEvent: () => {},
    });
    t.after(() => httpViewer.close());
    const snapshot = await httpViewer.read({ viewId: "match", entityId: "42" });
    assert.ok(snapshot);
    assert.equal(
      (snapshot.data as Record<string, Record<string, Decimal>>).score.score
        .text,
      "9007199254740993",
    );
    assert.equal(
      await httpViewer.read({ viewId: "unknown", entityId: "42" }),
      null,
    );
    await viewer.unsubscribe({ viewId: "match", entityId: "42" });
    assert.ok(await viewer.read({ viewId: "match", entityId: "42" }));
  },
);
