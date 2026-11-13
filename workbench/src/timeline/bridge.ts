import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { requireHostArtifact } from "./host-artifact.js";

import {
  decodeHandshake,
  decodeResponse,
  type Response,
  type TimingDiagnostics,
} from "./host-protocol.js";
export type {
  Effect,
  Response,
  SessionEffect,
  TimingDiagnostics,
} from "./host-protocol.js";

const cap = 16 * 1024 * 1024;
const watchdogMs = 15_000;
const maxTimeMs = 3_600_000;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type GenerationIdentity = Readonly<{
  runtimeGeneration: number;
  startTimeMs: number;
  firstTurnId: number;
}>;
type ExitStatus = { code: number | null; signal: NodeJS.Signals | null };

/** Private framed bridge. Never builds Java or treats host latency as simulated time. */
export class Bridge {
  private buffer = Buffer.alloc(0);
  private waiting?: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  };
  private commandActive = false;
  private closed = false;
  private completing = false;
  private failure?: Error;
  private turn: number;
  private epoch = 1_000_000;
  private acknowledged?: { operation: unknown; timeMs: number };
  environment?: Record<string, string>;
  timing?: TimingDiagnostics;
  readonly hostPauses: {
    turn: number;
    timeMs: number;
    operation: string;
    requestedMillis: number;
    elapsedNanos: number;
  }[] = [];
  configurationAdmission = 0;
  documentFormats: readonly string[] = [];
  private diagnostics = "";
  private readonly child: ChildProcessWithoutNullStreams;
  private exitStatus?: ExitStatus;
  private readonly exited: Promise<ExitStatus>;
  private constructor(
    jar: string,
    private readonly hostDelay: number,
    jvmPauseMs: number,
    private readonly generation?: GenerationIdentity,
  ) {
    this.turn = generation?.firstTurnId ?? 0;
    this.child = spawn(
      "java",
      [
        "-Xms16m",
        "-Xmx128m",
        `-Dzooglass.simulation.pauseMillis=${jvmPauseMs}`,
        `-Dzooglass.simulation.artifact=${jar}`,
        `-Dzooglass.simulation.protocol=${this.protocol}`,
        "-jar",
        jar,
      ],
      { stdio: "pipe" },
    );
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        this.exitStatus = { code, signal };
        resolve(this.exitStatus);
      });
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.diagnostics = (this.diagnostics + chunk.toString()).slice(-8192);
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.failure || !chunk.length) return;
      try {
        const waiter = this.waiting;
        if (!waiter) throw new Error("Unsolicited bridge frame");

        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (this.buffer.length < 4) return;
        const length = this.buffer.readUInt32BE(0);
        if (length < 1 || length > cap)
          throw new Error("Invalid bridge frame size");
        if (this.buffer.length < length + 4) return;
        if (this.buffer.length > length + 4)
          throw new Error("Unsolicited bridge frame");

        const value: unknown = JSON.parse(utf8.decode(this.buffer.subarray(4)));
        this.buffer = Buffer.alloc(0);
        this.waiting = undefined;
        waiter.resolve(value);
      } catch (error) {
        this.fail(error as Error);
      }
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      if (!this.completing) this.fail(this.exitError(code, signal));
    });
    this.child.stdin.on("error", (error) => this.fail(error));
  }
  static async open(
    jar: string,
    hostDelay = 0,
    jvmPauseMs = 0,
    generation?: GenerationIdentity,
  ): Promise<{ bridge: Bridge; artifact: string }> {
    if (!Number.isSafeInteger(hostDelay) || hostDelay < 0 || hostDelay > 250)
      throw new Error("Invalid Node host pause");
    if (!Number.isSafeInteger(jvmPauseMs) || jvmPauseMs < 0 || jvmPauseMs > 250)
      throw new Error("Invalid JVM host pause");
    const identity = generation === undefined ? undefined : { ...generation };
    if (
      identity &&
      (!Number.isSafeInteger(identity.runtimeGeneration) ||
        identity.runtimeGeneration < 1 ||
        identity.runtimeGeneration > 16 ||
        !Number.isSafeInteger(identity.startTimeMs) ||
        identity.startTimeMs < 0 ||
        identity.startTimeMs > maxTimeMs ||
        (identity.runtimeGeneration === 1 && identity.startTimeMs !== 0) ||
        !Number.isSafeInteger(identity.firstTurnId) ||
        identity.firstTurnId < 0)
    )
      throw new Error("Invalid runtime generation identity");
    const bytes = await readFile(jar);
    await requireHostArtifact(bytes);
    const artifact = createHash("sha256").update(bytes).digest("hex");
    const bridge = new Bridge(jar, hostDelay, jvmPauseMs, identity);
    try {
      const frame = await bridge.read();
      if (bridge.failure) throw bridge.failure;
      const handshake = decodeHandshake(frame);
      if (
        handshake.protocol !== bridge.protocol ||
        handshake.fixture !== "timeline-proof-v1" ||
        handshake.artifact !== artifact ||
        handshake.frameCap !== cap
      ) {
        throw new Error("Unsupported or mismatched simulation artifact");
      }
      if (
        handshake.protocol === 1 &&
        handshake.configurationAdmission !== undefined
      ) {
        if (handshake.configurationAdmission !== 1) {
          throw new Error("Unsupported configuration admission protocol");
        }
        bridge.configurationAdmission = 1;
        bridge.documentFormats = Object.freeze([...handshake.documentFormats]);
      }
      bridge.environment = handshake.environment;
      return { bridge, artifact };
    } catch (error) {
      await bridge.close().catch(() => {});
      throw error;
    }
  }
  get protocol(): 1 | 2 {
    return this.generation ? 2 : 1;
  }
  get memoryLifecycle(): 0 | 1 {
    return this.generation ? 1 : 0;
  }
  private exitError(code: number | null, signal: NodeJS.Signals | null) {
    return new Error(`Runtime exited (${signal ?? code}): ${this.diagnostics}`);
  }
  private fail(error: Error) {
    this.failure ??= error;
    this.buffer = Buffer.alloc(0);
    this.waiting?.reject(error);
    this.waiting = undefined;
  }
  private read(): Promise<unknown> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (this.waiting) {
      return Promise.reject(new Error("Overlapping bridge commands"));
    }
    return new Promise((resolve, reject) => {
      const watchdog = setTimeout(() => {
        this.fail(new Error("Infrastructure watchdog expired"));
        this.child.kill("SIGKILL");
      }, watchdogMs);
      this.waiting = {
        resolve: (value) => {
          clearTimeout(watchdog);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(watchdog);
          reject(error);
        },
      };
    });
  }
  private admitGenerationCommand(
    timeMs: number,
    operation: Record<string, unknown>,
  ) {
    if (!this.generation) return;
    if (this.closed || this.acknowledged?.operation === "shutdown")
      throw new Error("Runtime generation is closed");

    const start = this.generation.startTimeMs;
    const op = operation.op;
    if (!this.acknowledged) {
      if (
        op !== "initialize-document" ||
        timeMs !== start ||
        (operation.startTimeMs !== undefined && operation.startTimeMs !== start)
      )
        throw new Error(
          "First generation command must initialize at its start time",
        );
    } else if (
      op === "initialize" ||
      op === "initialize-document" ||
      op === "inspect-configuration"
    ) {
      throw new Error("Invalid command for an initialized generation");
    }

    if (
      !Number.isSafeInteger(timeMs) ||
      timeMs < (this.acknowledged?.timeMs ?? start) ||
      timeMs > maxTimeMs ||
      !Number.isSafeInteger(this.turn)
    )
      throw new Error("Invalid generation command time or turn");
  }
  async command(
    timeMs: number,
    requested: Record<string, unknown>,
  ): Promise<Response> {
    if (this.commandActive) {
      throw new Error("Overlapping bridge commands");
    }
    this.commandActive = true;
    try {
      const operation = { ...requested };
      this.admitGenerationCommand(timeMs, operation);
      if (this.hostDelay) {
        const before = process.hrtime.bigint();
        await delay(this.hostDelay);
        this.hostPauses.push({
          turn: this.turn,
          timeMs,
          operation: String(operation.op),
          requestedMillis: this.hostDelay,
          elapsedNanos: Number(process.hrtime.bigint() - before),
        });
      }
      if (this.failure) {
        throw this.failure;
      }
      let commandEpoch = this.epoch;
      if (operation.op === "initialize-document") {
        if (
          !Number.isSafeInteger(operation.epochMillis) ||
          Number(operation.epochMillis) < 0
        )
          throw new Error("Invalid document epoch");
        commandEpoch = Number(operation.epochMillis);
      }
      const turnId = this.turn;
      const runtimeGeneration = this.generation?.runtimeGeneration ?? 1;
      const monotonicMs = this.generation
        ? timeMs - this.generation.startTimeMs
        : timeMs;
      const wallMillis = commandEpoch + timeMs;
      if (this.generation && !Number.isSafeInteger(wallMillis))
        throw new Error("Invalid generation wall clock");
      const bytes = Buffer.from(
        JSON.stringify({
          ...operation,
          ...(this.generation && operation.op === "initialize-document"
            ? { startTimeMs: this.generation.startTimeMs }
            : {}),
          turnId,
          runtimeGeneration,
          timeMs,
          monotonicMs,
          wallMillis,
        }),
      );
      if (bytes.length > cap) {
        throw new Error("Command frame overflow");
      }
      this.epoch = commandEpoch;
      this.turn++;
      const header = Buffer.alloc(4);
      header.writeUInt32BE(bytes.length);
      const response = this.read();
      this.child.stdin.write(Buffer.concat([header, bytes]));
      try {
        const frame = await response;
        if (this.failure) throw this.failure;
        const value = decodeResponse(frame, this.protocol);
        if (
          value.turnId !== turnId ||
          value.runtimeGeneration !== runtimeGeneration ||
          value.timeMs !== timeMs
        )
          throw new Error("Mismatched turn response");
        if (
          this.generation &&
          (value.monotonicMs !== monotonicMs || value.wallMillis !== wallMillis)
        )
          throw new Error("Mismatched generation response clocks");
        if (value.diagnostics) this.timing = value.diagnostics;
        if (this.generation)
          this.acknowledged = { operation: operation.op, timeMs };
        return value;
      } catch (error) {
        if (this.generation && error instanceof Error) this.fail(error);
        throw error;
      }
    } finally {
      this.commandActive = false;
    }
  }

  /** Complete an acknowledged shutdown by sending EOF and requiring a normal exit. */
  async finishOrderly() {
    await this.finish("orderly");
  }

  /** Terminate a live generation between acknowledgments, without sending shutdown or EOF. */
  async finishAbruptly() {
    await this.finish("abrupt");
  }

  private async finish(mode: "orderly" | "abrupt") {
    if (this.commandActive) throw new Error("Overlapping bridge commands");
    if (this.closed) throw new Error("Runtime generation is closed");
    if (this.failure) throw this.failure;
    if (this.exitStatus)
      throw this.exitError(this.exitStatus.code, this.exitStatus.signal);
    if (this.child.exitCode != null || this.child.signalCode != null)
      throw this.exitError(this.child.exitCode, this.child.signalCode);
    if (
      !this.generation ||
      !this.acknowledged ||
      (this.acknowledged.operation === "shutdown") !== (mode === "orderly")
    )
      throw new Error(`No acknowledged turn for ${mode} runtime completion`);

    this.closed = true;
    this.completing = true;
    try {
      if (mode === "orderly") this.child.stdin.end();
      else if (!this.child.kill("SIGKILL"))
        throw new Error("Runtime exited before abrupt completion");

      const { code, signal } = await this.waitForExit(
        `${mode} runtime completion`,
      );
      if (this.failure) throw this.failure;
      if (
        mode === "orderly"
          ? code !== 0 || signal !== null
          : code !== null || signal !== "SIGKILL"
      )
        throw new Error(
          `Unexpected ${mode} completion: ${this.exitError(code, signal).message}`,
        );
    } finally {
      this.completing = false;
    }
  }

  private async waitForExit(operation: string) {
    let watchdog: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => {
          reject(
            new Error(`Infrastructure watchdog expired during ${operation}`),
          );
          this.forceTerminate();
        }, watchdogMs);
      });
      return await Promise.race([this.exited, timeout]);
    } finally {
      clearTimeout(watchdog);
    }
  }

  private forceTerminate() {
    this.child.kill("SIGKILL");
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }

  async close() {
    if (this.generation) {
      this.closed = true;
      this.fail(new Error("Runtime generation is closed"));
      if (this.exitStatus) return;
      this.forceTerminate();
      await this.waitForExit("runtime cleanup");
      return;
    }
    this.child.stdin.end();
    this.child.kill("SIGKILL");
    await this.exited;
  }
}
