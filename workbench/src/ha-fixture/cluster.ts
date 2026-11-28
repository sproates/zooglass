import { randomBytes } from "node:crypto";
import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import net from "node:net";
import { fixtureRequest as request, waitUntil } from "./requests.js";
export { waitUntil } from "./requests.js";
import { OwnedDocker, docker, pinned } from "./docker.js";
import { BarrierFiles, type BarrierStage } from "./barriers.js";
import { proxyHealth, type ProxyHealth } from "./proxy-health.js";
import { certificates } from "./certificates.js";
import {
  application,
  proxyConfiguration,
  type RestartOverrides,
} from "./configuration.js";
import type {
  Credentials,
  FixtureOptions,
  NodeName,
  PolicyMode,
} from "./types.js";

export interface SourceResult {
  status: "resolved" | "unresolved";
  receiptJson?: string;
  reason?: string;
  publication?: { bytes: string; incarnation?: string };
}
export interface NodeFixture {
  name: NodeName;
  container: string;
  viewer: string;
  control: string;
  publish(bytes: string): Promise<SourceResult>;
  discardAfterReconciliation(bytes: string): Promise<void>;
  armBarrier(stage: BarrierStage): Promise<string>;
  waitBarrier(stage: BarrierStage, token: string): Promise<void>;
  releaseBarrier(
    stage: BarrierStage,
    token: string,
  ): Promise<"resumed" | "interrupted">;
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  restart(overrides?: RestartOverrides): Promise<void>;
  partitionDb(cut: boolean): Promise<void>;
  operatorRequest(
    path: string,
    method: string,
    upgrade?: boolean,
  ): Promise<{ status: number; body: string }>;
}
export class HaCluster {
  readonly nodes: NodeFixture[] = [];
  readonly credentials: Credentials;
  readonly postgresContainer: string;
  readonly journal: string;
  readonly leaseMillis = 6000;
  get mode() {
    return this.options.mode;
  }
  readonly proxy: {
    origin: string;
    health: () => Promise<ProxyHealth[]>;
    pinHealth: (node: NodeName | undefined) => Promise<void>;
    configureProbe: (options?: {
      token?: string;
      verifyHost?: string;
    }) => Promise<void>;
  };
  private readonly owned = new OwnedDocker();
  private readonly names: Record<string, string>;
  readonly namePrefix: string;
  get resourceNames(): readonly string[] {
    return Object.values(this.names);
  }
  private abortListener?: () => void;
  private constructor(
    readonly directory: string,
    readonly ca: Buffer,
    private readonly password: string,
    private readonly options: FixtureOptions,
    readonly runId: string,
  ) {
    this.namePrefix = `zooglass-ha-${runId}-`;
    this.credentials = Object.fromEntries(
      ["control", "probe", "operator", "policy", "database"].map((key) => [
        key,
        randomBytes(24).toString("hex"),
      ]),
    ) as unknown as Credentials;
    this.names = Object.fromEntries(
      [
        "network",
        "database",
        "node-a",
        "node-b",
        "sidecar-a",
        "sidecar-b",
        "proxy",
      ].map((key) => [key, `zooglass-ha-${runId}-${key}`]),
    );
    this.postgresContainer = this.names.database;
    this.journal = join(directory, "ownership.json");
    this.proxy = {
      origin: "",
      health: async () => proxyHealth(await this.adminReply("show stat")),
      pinHealth: (node) => this.pinHealth(node),
      configureProbe: (options) => this.configureProbe(options),
    };
  }
  static async open(options: FixtureOptions): Promise<HaCluster> {
    Object.values(options.images).forEach(pinned);
    await access(options.jar);
    if (options.faultAgent) await access(options.faultAgent);
    await access(join(options.dist, "ha-fixture/sidecar.js"));
    const scratch = fileURLToPath(
      new URL("../../test-results/ha-fixtures/", import.meta.url),
    );
    if (!options.directory) await mkdir(scratch, { recursive: true });
    const directory = options.directory
      ? resolve(options.directory)
      : await mkdtemp(join(scratch, "cluster-"));
    await mkdir(directory, { recursive: true });
    const tls = await certificates(directory),
      cluster = new HaCluster(
        directory,
        tls.ca,
        tls.password,
        options,
        randomBytes(6).toString("hex"),
      );
    try {
      await cluster.start();
      return cluster;
    } catch (error) {
      try {
        await cluster.close();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Fixture startup and cleanup failed",
          { cause: cleanup },
        );
      }
      throw error;
    }
  }
  private async create(
    name: string,
    args: string[],
    network = false,
  ): Promise<void> {
    await this.owned.create(
      network ? "network" : "container",
      name,
      ["--label", `zooglass.ha-fixture=${this.runId}`, ...args],
      this.options.signal,
    );
    if (!network) await docker(["start", name], undefined, this.options.signal);
  }
  private async port(container: string, port: number): Promise<number> {
    const raw = JSON.parse(
      await docker([
        "inspect",
        "--format",
        "{{json .NetworkSettings.Ports}}",
        container,
      ]),
    ) as Record<string, { HostIp: string; HostPort: string }[]>;
    const mapping = raw[`${port}/tcp`];
    if (mapping?.length !== 1 || mapping[0].HostIp !== "127.0.0.1")
      throw new Error("Expected one loopback-only fixture port");
    return Number(mapping[0].HostPort);
  }
  private async start(): Promise<void> {
    const opts = this.options,
      signal = opts.signal;
    signal?.throwIfAborted();
    await writeFile(
      this.journal,
      JSON.stringify(
        {
          runId: this.runId,
          network: this.names.network,
          containers: Object.entries(this.names)
            .filter(([key]) => key !== "network")
            .map(([, value]) => value),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await mkdir(join(this.directory, "dist"), { recursive: true });
    for (const path of ["ha-fixture", "service/ha", "json"])
      await cp(join(opts.dist, path), join(this.directory, "dist", path), {
        recursive: true,
      });
    const require = createRequire(import.meta.url);
    await cp(
      dirname(require.resolve("ws/package.json")),
      join(this.directory, "node_modules/ws"),
      { recursive: true },
    );
    await cp(opts.jar, join(this.directory, "service.jar"));
    if (opts.faultAgent)
      await cp(opts.faultAgent, join(this.directory, "ha-fault-agent.jar"));
    await writeFile(join(this.directory, "package.json"), '{"type":"module"}');
    await writeFile(
      join(this.directory, "sidecar-settings.json"),
      JSON.stringify(
        Object.fromEntries(
          (["node-a", "node-b"] as const).map((name) => [
            name,
            {
              name,
              mode: opts.mode,
              controlToken: this.credentials.control,
              operatorToken: this.credentials.operator,
              policyToken: this.credentials.policy,
            },
          ]),
        ),
      ),
      { mode: 0o600 },
    );
    await writeFile(
      join(this.directory, "database.env"),
      `POSTGRES_USER=fixture\nPOSTGRES_DB=fixture\nPOSTGRES_PASSWORD=${this.credentials.database}\n`,
      { mode: 0o600 },
    );
    await this.create(this.names.network, [], true);
    await mkdir(join(this.directory, "database-data"), { recursive: true });
    await this.create(this.names.database, [
      "--mount",
      `type=bind,src=${join(this.directory, "database-data")},dst=/var/lib/postgresql`,
      "--network",
      this.names.network,
      "--network-alias",
      "database",
      "--env-file",
      join(this.directory, "database.env"),
      opts.images.postgres,
    ]);
    await waitUntil(async () => {
      await docker(
        [
          "exec",
          this.names.database,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "fixture",
          "-d",
          "fixture",
        ],
        undefined,
        signal,
      );
      return true;
    }, signal);
    for (const [index, name] of (["node-a", "node-b"] as const).entries()) {
      const run = join(this.directory, name);
      await mkdir(run, { recursive: true });
      const container = this.names[name];
      await this.create(container, [
        "--network",
        this.names.network,
        "--network-alias",
        name,
        "-p",
        "127.0.0.1::8443",
        "-p",
        "127.0.0.1::19090",
        "--mount",
        `type=bind,src=${this.directory},dst=/fixture,readonly`,
        "--mount",
        `type=bind,src=${run},dst=/run/ha`,
        opts.images.jre,
        "sleep",
        "infinity",
      ]);
      await this.create(this.names[index === 0 ? "sidecar-a" : "sidecar-b"], [
        "--network",
        `container:${container}`,
        "--mount",
        `type=bind,src=${this.directory},dst=/fixture,readonly`,
        "-e",
        `HA_NODE=${name}`,
        opts.images.node,
        "node",
        "/fixture/dist/ha-fixture/sidecar.js",
      ]);
      const barriers = new BarrierFiles(join(run, "barriers"), signal);
      const node: NodeFixture = {
        armBarrier: (stage) => barriers.arm(stage),
        waitBarrier: (stage, token) => barriers.waitReached(stage, token),
        releaseBarrier: (stage, token) => barriers.release(stage, token),
        name,
        container,
        viewer: `https://localhost:${await this.port(container, 8443)}`,
        control: `http://127.0.0.1:${await this.port(container, 19090)}`,
        publish: async (bytes) =>
          this.control(node, "/publish", { bytes }) as Promise<SourceResult>,
        discardAfterReconciliation: async (bytes) => {
          const result = (await this.control(
            node,
            "/discard-after-reconciliation",
            { bytes },
          )) as { discarded?: boolean };
          if (result.discarded !== true)
            throw new Error(
              "Fixture reconciliation did not discard the named publication",
            );
        },
        kill: (signal) =>
          this.signalNode(node, signal === "SIGTERM" ? "TERM" : "KILL"),
        pause: () => this.signalNode(node, "STOP"),
        resume: () => this.signalNode(node, "CONT"),
        restart: (overrides) => this.launch(node, overrides),
        operatorRequest: async (path, method, upgrade) =>
          (await this.control(node, "/operator-request", {
            path,
            method,
            upgrade,
          })) as { status: number; body: string },
        partitionDb: async (cut) => {
          await this.control(node, "/database", { cut });
        },
      };
      this.nodes.push(node);
      await waitUntil(async (deadline) => {
        const reply = await this.control(node, "/ready", undefined, deadline);
        return reply ? true : undefined;
      }, signal);
    }
    await Promise.all(this.nodes.map((node) => this.launch(node)));
    await writeFile(
      join(this.directory, "haproxy.cfg"),
      proxyConfiguration(this.credentials),
    );
    await this.create(this.names.proxy, [
      "--network",
      this.names.network,
      "-p",
      "127.0.0.1::8443",
      "-p",
      "127.0.0.1::9999",
      "--mount",
      `type=bind,src=${this.directory},dst=/fixture,readonly`,
      "--user",
      "0:0",
      opts.images.haproxy,
      "haproxy",
      "-W",
      "-db",
      "-f",
      "/fixture/haproxy.cfg",
    ]);
    this.proxy.origin = `https://localhost:${await this.port(this.names.proxy, 8443)}`;
    this.abortListener = () => {
      void this.close().catch(() => {
        /* The caller's awaited close reports cleanup failures. */
      });
    };
    signal?.addEventListener("abort", this.abortListener, { once: true });
    await this.readyOwner();
  }
  private async control(
    node: NodeFixture,
    path: string,
    body?: unknown,
    signal = this.options.signal,
  ): Promise<unknown> {
    const result = await request(
      node.control + path,
      this.credentials.control,
      undefined,
      body,
      signal,
      path === "/publish" ? 35000 : 5000,
    );
    if (result.status !== 200)
      throw new Error(`Fixture control ${path} returned ${result.status}`);
    return JSON.parse(result.body) as unknown;
  }
  private async signalNode(
    node: NodeFixture,
    signal: "KILL" | "TERM" | "STOP" | "CONT",
  ): Promise<void> {
    await docker(
      [
        "exec",
        node.container,
        "sh",
        "-c",
        `if test -f /run/ha/java.pid && kill -0 "$(cat /run/ha/java.pid)" 2>/dev/null; then kill -${signal} "$(cat /run/ha/java.pid)"; fi`,
      ],
      undefined,
      this.options.signal,
    );
    if (signal === "TERM" || signal === "KILL") {
      await waitUntil(
        async (deadline) => {
          const state = await docker(
            [
              "exec",
              node.container,
              "sh",
              "-c",
              'if ! test -f /run/ha/java.pid; then echo stopped; else pid=$(cat /run/ha/java.pid); if ! kill -0 "$pid" 2>/dev/null || grep -q "^State:.*Z" "/proc/$pid/status" 2>/dev/null; then echo stopped; fi; fi',
            ],
            undefined,
            deadline,
          );
          return state === "stopped" ? true : undefined;
        },
        this.options.signal,
        8000,
      );
    }
  }
  private async launch(
    node: NodeFixture,
    overrides: RestartOverrides = {},
  ): Promise<void> {
    await this.signalNode(node, "KILL");
    await rm(join(this.directory, node.name, "barriers"), {
      recursive: true,
      force: true,
    });
    await mkdir(join(this.directory, node.name, "barriers"), {
      recursive: true,
    });
    await writeFile(
      join(this.directory, node.name, "config.json"),
      JSON.stringify(overrides.configuration ?? this.options.configuration),
    );
    const config = application(
      this.options.mode,
      node.name,
      this.credentials,
      this.password,
      overrides,
    );
    await docker(
      [
        "exec",
        "-d",
        "-e",
        `SPRING_APPLICATION_JSON=${JSON.stringify(config)}`,
        node.container,
        "sh",
        "-c",
        `echo $$ > /run/ha/java.pid; exec java ${this.options.faultAgent ? "-javaagent:/fixture/ha-fault-agent.jar=/run/ha/barriers " : ""}-Djavax.net.ssl.trustStore=/fixture/trust.p12 -Djavax.net.ssl.trustStorePassword=ephemeral-ha-fixture -jar /fixture/service.jar >> /run/ha/service.log 2>&1`,
      ],
      undefined,
      this.options.signal,
    );
  }
  async policy(
    mode: PolicyMode,
    lifetimeMillis?: number,
    delayMillis?: number,
  ): Promise<void> {
    await this.control(this.nodes[0], "/policy", {
      mode,
      lifetimeMillis,
      delayMillis,
    });
  }
  async policyState(): Promise<{
    mode: PolicyMode;
    decisions: number;
    lifetimeMillis: number;
    delayMillis: number;
    pendingResponses: number;
  }> {
    return (await this.control(this.nodes[0], "/policy")) as {
      mode: PolicyMode;
      decisions: number;
      lifetimeMillis: number;
      delayMillis: number;
      pendingResponses: number;
    };
  }
  async database(available: boolean): Promise<void> {
    await docker(
      available
        ? ["start", this.names.database]
        : ["stop", "--time", "1", this.names.database],
      undefined,
      this.options.signal,
    );
    if (available)
      await waitUntil(async () => {
        await docker(
          [
            "exec",
            this.names.database,
            "pg_isready",
            "-h",
            "127.0.0.1",
            "-U",
            "fixture",
            "-d",
            "fixture",
          ],
          undefined,
          this.options.signal,
        );
        return true;
      }, this.options.signal);
  }
  async sql(sql: string, signal?: AbortSignal): Promise<string> {
    return docker(
      [
        "exec",
        "-i",
        this.names.database,
        "psql",
        "-X",
        "-q",
        "-A",
        "-t",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "fixture",
        "-d",
        "fixture",
      ],
      sql,
      signal ?? this.options.signal,
    );
  }
  async readyOwner(): Promise<{
    index: number;
    generation: bigint;
    incarnation: string;
  }> {
    return waitUntil(async (deadline) => {
      for (const [index, node] of this.nodes.entries()) {
        try {
          const ready = await request(
            node.viewer + "/ha/ready",
            this.credentials.probe,
            this.ca,
            undefined,
            deadline,
          );
          if (ready.status !== 200) continue;
          const observed = (await this.control(
            node,
            "/owner",
            undefined,
            deadline,
          )) as { generation: string; incarnation: string };
          return {
            index,
            generation: BigInt(observed.generation),
            incarnation: observed.incarnation,
          };
        } catch {
          /* Both candidates may legitimately be unavailable during takeover. */
        }
      }
      return undefined;
    }, this.options.signal);
  }
  private async admin(command: string): Promise<void> {
    const answer = await this.adminReply(command);
    if (answer.trim())
      throw new Error(`Proxy administration refused: ${answer.trim()}`);
  }
  private async adminReply(command: string): Promise<string> {
    const port = await this.port(this.names.proxy, 9999);
    return new Promise<string>((resolve, reject) => {
      const socket = net.connect({
        port,
        host: "127.0.0.1",
        signal: this.options.signal,
      });
      let answer = "";
      socket.setTimeout(3000, () =>
        socket.destroy(new Error("Proxy administration deadline")),
      );
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        answer += String(chunk);
        if (answer.length > 16384)
          socket.destroy(
            new Error("Proxy administration response exceeded bound"),
          );
      });
      socket.on("connect", () => socket.end(command + "\n"));
      socket.on("end", () => resolve(answer));
    });
  }
  private async pinHealth(node: NodeName | undefined): Promise<void> {
    for (const name of ["node-a", "node-b"]) {
      await this.admin(`${node ? "disable" : "enable"} health zoo/${name}`);
      if (node)
        await this.admin(
          `set server zoo/${name} health ${node === name ? "up" : "down"}`,
        );
    }
  }
  private async configureProbe(
    options: { token?: string; verifyHost?: string } = {},
  ): Promise<void> {
    if (options.token && !/^[A-Za-z0-9_-]{1,128}$/.test(options.token))
      throw new Error("Invalid fixture probe override");
    if (options.verifyHost && !/^[a-z0-9.-]{1,128}$/.test(options.verifyHost))
      throw new Error("Invalid fixture probe hostname");
    await writeFile(
      join(this.directory, "haproxy.cfg"),
      proxyConfiguration(this.credentials, options.token, options.verifyHost),
    );
    await docker(
      ["exec", this.names.proxy, "haproxy", "-c", "-f", "/fixture/haproxy.cfg"],
      undefined,
      this.options.signal,
    );
    // Reload the master, not the container: Docker reassigns ephemeral published ports on restart.
    await docker(
      ["kill", "--signal", "USR2", this.names.proxy],
      undefined,
      this.options.signal,
    );
    const published = `https://localhost:${await this.port(this.names.proxy, 8443)}`;
    if (published !== this.proxy.origin)
      throw new Error("Proxy reload changed the stable origin");
  }
  private closeTask?: Promise<void>;
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    if (this.abortListener)
      this.options.signal?.removeEventListener("abort", this.abortListener);
    this.closeTask = (async () => {
      for (const [key, name] of Object.entries(this.names)) {
        if (key === "network") continue;
        try {
          await writeFile(
            join(this.directory, `${key}.container.log`),
            await docker(["logs", "--tail", "200", name]),
          );
        } catch {
          /* Cleanup still runs when logs cannot be read. */
        }
      }
      await this.owned.close();
    })();
    return this.closeTask;
  }
}
