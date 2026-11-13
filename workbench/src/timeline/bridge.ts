import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export type Effect = {
  kind: string;
  task?: number;
  at?: number;
  phase?: number;
  taskKind?: string;
  session?: string;
  wire?: string;
  code?: number;
};
export type Response = {
  turnId: number;
  runtimeGeneration: number;
  timeMs: number;
  effects: Effect[];
  pendingTasks: number;
  heldFrames: number;
  configuration?: { contractVersion: number; storage: string };
};
const cap = 16 * 1024 * 1024;

/** Private framed bridge. Never builds Java or treats host latency as simulated time. */
export class Bridge {
  private buffer = Buffer.alloc(0);
  private waiting?: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  };
  private commandActive = false;
  private failure?: Error;
  private turn = 0;
  configurationAdmission = 0;
  documentFormats: readonly string[] = [];
  private diagnostics = "";
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  private constructor(
    jar: string,
    private readonly hostDelay: number,
  ) {
    this.child = spawn(
      "java",
      [
        "-Xms16m",
        "-Xmx128m",
        `-Dzooglass.simulation.artifact=${jar}`,
        "-Dloader.main=io.zooglass.simulation.TimelineHost",
        "-cp",
        jar,
        "org.springframework.boot.loader.launch.PropertiesLauncher",
      ],
      { stdio: "pipe" },
    );
    this.exited = new Promise((resolve) =>
      this.child.once("close", () => resolve()),
    );
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.diagnostics = (this.diagnostics + chunk.toString()).slice(-8192);
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
          const length = this.buffer.readUInt32BE(0);
          if (length < 1 || length > cap) {
            throw new Error("Invalid bridge frame size");
          }
          if (this.buffer.length < length + 4) {
            break;
          }
          const value: unknown = JSON.parse(
            this.buffer.subarray(4, length + 4).toString("utf8"),
          );
          this.buffer = this.buffer.subarray(length + 4);
          if (this.waiting) {
            const waiter = this.waiting;
            this.waiting = undefined;
            waiter.resolve(value);
          } else {
            throw new Error("Unsolicited bridge frame");
          }
        }
      } catch (error) {
        this.fail(error as Error);
      }
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code) =>
      this.fail(new Error(`Runtime exited (${code}): ${this.diagnostics}`)),
    );
    this.child.stdin.on("error", (error) => this.fail(error));
  }
  static async open(
    jar: string,
    hostDelay = 0,
  ): Promise<{ bridge: Bridge; artifact: string }> {
    const artifact = createHash("sha256")
      .update(await readFile(jar))
      .digest("hex");
    const bridge = new Bridge(jar, hostDelay);
    try {
      const handshake = (await bridge.read()) as Record<string, unknown>;
      if (
        handshake.protocol !== 1 ||
        handshake.fixture !== "timeline-proof-v1" ||
        handshake.artifact !== artifact ||
        handshake.frameCap !== cap
      ) {
        throw new Error("Unsupported or mismatched simulation artifact");
      }
      if (handshake.configurationAdmission !== undefined) {
        if (
          handshake.configurationAdmission !== 1 ||
          !Array.isArray(handshake.documentFormats) ||
          !handshake.documentFormats.every((value) => typeof value === "string")
        ) {
          throw new Error("Unsupported configuration admission protocol");
        }
        bridge.configurationAdmission = 1;
        bridge.documentFormats = Object.freeze([
          ...handshake.documentFormats,
        ]) as readonly string[];
      }
      return { bridge, artifact };
    } catch (error) {
      await bridge.close();
      throw error;
    }
  }
  private fail(error: Error) {
    this.failure ??= error;
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
      }, 15000);
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
  async command(
    timeMs: number,
    operation: Record<string, unknown>,
  ): Promise<Response> {
    if (this.commandActive) {
      throw new Error("Overlapping bridge commands");
    }
    this.commandActive = true;
    try {
      if (this.hostDelay) {
        await delay(this.hostDelay);
      }
      if (this.failure) {
        throw this.failure;
      }
      const turnId = this.turn;
      const bytes = Buffer.from(
        JSON.stringify({
          ...operation,
          turnId,
          runtimeGeneration: 1,
          timeMs,
          monotonicMs: timeMs,
          wallMillis: 1_000_000 + timeMs,
        }),
      );
      if (bytes.length > cap) {
        throw new Error("Command frame overflow");
      }
      this.turn++;
      const header = Buffer.alloc(4);
      header.writeUInt32BE(bytes.length);
      const response = this.read();
      this.child.stdin.write(Buffer.concat([header, bytes]));
      const value = (await response) as Response;
      if (
        value.turnId !== turnId ||
        value.runtimeGeneration !== 1 ||
        value.timeMs !== timeMs ||
        !Array.isArray(value.effects)
      ) {
        throw new Error("Mismatched turn response");
      }
      return value;
    } finally {
      this.commandActive = false;
    }
  }
  async close() {
    this.child.stdin.end();
    this.child.kill("SIGKILL");
    await this.exited;
  }
}
