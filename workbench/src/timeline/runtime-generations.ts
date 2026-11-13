import { Bridge, type Response, type TimingDiagnostics } from "./bridge.js";

export type RuntimeGeneration = Readonly<{
  number: number;
  startTimeMs: number;
}>;

export type GenerationOptions = Readonly<{
  jar: string;
  configuration: string;
  epochMillis: number;
  commandLimit: number;
  hostDelay?: number;
  jvmPauseMs?: number;
  expectedArtifact?: string;
  expectedEnvironment?: Record<string, string>;
}>;

function environmentKey(environment: Record<string, string>) {
  return JSON.stringify(
    Object.entries(environment).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  );
}

/** Owns fresh host processes; agenda, connection and retry ownership remain external. */
export class RuntimeGenerations {
  private readonly options: GenerationOptions;
  private bridge?: Bridge;
  private identity?: RuntimeGeneration;
  private generation = 0;
  private nextTurn = 0;
  private timeMs = 0;
  private busy = false;
  private closed = false;
  private cleanup?: Promise<void>;
  private failure?: Error;
  private artifact?: string;
  private environment?: string;
  private readonly completedDiagnostics: {
    runtimeGeneration: number;
    jvm: TimingDiagnostics | null;
    node: Bridge["hostPauses"];
  }[] = [];
  get diagnostics() {
    return [
      ...this.completedDiagnostics,
      ...(this.bridge && this.identity
        ? [
            {
              runtimeGeneration: this.identity.number,
              jvm: this.bridge.timing ?? null,
              node: [...this.bridge.hostPauses],
            },
          ]
        : []),
    ];
  }
  private retainDiagnostics() {
    if (this.bridge && this.identity)
      this.completedDiagnostics.push({
        runtimeGeneration: this.identity.number,
        jvm: this.bridge.timing ?? null,
        node: [...this.bridge.hostPauses],
      });
  }

  constructor(options: GenerationOptions) {
    if (
      !Number.isSafeInteger(options.epochMillis) ||
      options.epochMillis < 0 ||
      !Number.isSafeInteger(options.commandLimit) ||
      options.commandLimit < 1 ||
      options.commandLimit > 10000
    )
      throw new Error("Invalid runtime generation limits or epoch");
    this.options = Object.freeze({ ...options });
    this.artifact = options.expectedArtifact;
    this.environment =
      options.expectedEnvironment &&
      environmentKey(options.expectedEnvironment);
  }

  get current(): RuntimeGeneration | undefined {
    return this.identity;
  }

  private admit(timeMs: number) {
    if (this.busy) throw new Error("Overlapping runtime lifecycle operations");
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("Runtime generations are closed");
    if (
      !Number.isSafeInteger(timeMs) ||
      timeMs < this.timeMs ||
      timeMs > 3_600_000 ||
      !Number.isSafeInteger(this.options.epochMillis + timeMs)
    )
      throw new Error("Invalid global runtime time");
  }

  private requireGeneration(generation: RuntimeGeneration): Bridge {
    if (!this.bridge || !this.identity)
      throw new Error("Runtime is unavailable");
    if (generation !== this.identity)
      throw new Error("Stale runtime generation");
    return this.bridge;
  }

  private async perform<T>(timeMs: number, work: () => Promise<T>): Promise<T> {
    this.busy = true;
    this.timeMs = timeMs;
    try {
      return await work();
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.retainDiagnostics();
      const bridge = this.bridge;
      this.bridge = undefined;
      this.identity = undefined;
      // A cleanup failure must not replace the command/startup failure.
      await bridge?.close().catch(() => {});
      throw this.failure;
    } finally {
      this.busy = false;
    }
  }

  private async send(
    bridge: Bridge,
    timeMs: number,
    operation: Record<string, unknown>,
  ) {
    if (this.nextTurn >= this.options.commandLimit)
      throw new Error("limit-exceeded: runtime commands");
    const response = await bridge.command(timeMs, operation);
    if (response.turnId !== this.nextTurn)
      throw new Error("Global runtime turn mismatch");
    this.nextTurn++;
    return response;
  }

  async start(timeMs: number): Promise<Response> {
    this.admit(timeMs);
    if (this.bridge) throw new Error("Runtime is already available");
    if (this.generation === 0 && timeMs !== 0)
      throw new Error("Initial runtime starts at zero");
    if (this.generation >= 16)
      throw new Error("limit-exceeded: runtime generations");
    return this.perform(timeMs, async () => {
      if (this.nextTurn >= this.options.commandLimit)
        throw new Error("limit-exceeded: runtime commands");
      const identity = Object.freeze({
        number: this.generation + 1,
        startTimeMs: timeMs,
      });
      const opened = await Bridge.open(
        this.options.jar,
        this.options.hostDelay,
        this.options.jvmPauseMs,
        {
          runtimeGeneration: identity.number,
          startTimeMs: timeMs,
          firstTurnId: this.nextTurn,
        },
      );
      this.bridge = opened.bridge;
      if (
        !opened.bridge.environment ||
        !Object.keys(opened.bridge.environment).length
      )
        throw new Error("Runtime environment identity is missing");
      const environment = environmentKey(opened.bridge.environment);
      if (
        this.artifact !== undefined &&
        (this.artifact !== opened.artifact || this.environment !== environment)
      )
        throw new Error(
          "Runtime artifact or environment changed between generations",
        );
      this.artifact = opened.artifact;
      this.environment = environment;
      const response = await this.send(opened.bridge, timeMs, {
        op: "initialize-document",
        wire: this.options.configuration,
        epochMillis: this.options.epochMillis,
      });
      this.generation = identity.number;
      this.identity = identity;
      return response;
    });
  }

  async command(
    generation: RuntimeGeneration,
    timeMs: number,
    operation: Record<string, unknown>,
  ): Promise<Response> {
    const command = { ...operation };
    this.admit(timeMs);
    const bridge = this.requireGeneration(generation);
    if (
      [
        "initialize",
        "initialize-document",
        "inspect-configuration",
        "shutdown",
      ].includes(String(command.op))
    )
      throw new Error("Command belongs to runtime lifecycle ownership");
    return this.perform(timeMs, () => this.send(bridge, timeMs, command));
  }

  async stop(
    generation: RuntimeGeneration,
    timeMs: number,
    mode: "orderly" | "abrupt",
  ): Promise<Response | undefined> {
    this.admit(timeMs);
    const bridge = this.requireGeneration(generation);
    if (mode !== "orderly" && mode !== "abrupt")
      throw new Error("Invalid runtime stop mode");
    return this.perform(timeMs, async () => {
      let response: Response | undefined;
      if (mode === "orderly") {
        response = await this.send(bridge, timeMs, { op: "shutdown" });
        await bridge.finishOrderly();
      } else {
        await bridge.finishAbruptly();
      }
      this.retainDiagnostics();
      this.bridge = undefined;
      this.identity = undefined;
      return response;
    });
  }

  /** Force cleanup is not a simulated stop and never permits another generation. */
  async close() {
    if (this.busy) throw new Error("Overlapping runtime lifecycle operations");
    this.closed = true;
    this.retainDiagnostics();
    const bridge = this.bridge;
    this.bridge = undefined;
    this.identity = undefined;
    this.cleanup ??= bridge?.close() ?? Promise.resolve();
    await this.cleanup;
  }
}
