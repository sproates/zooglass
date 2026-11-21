import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  recordHash,
  exists,
  inventory,
  readRecord,
  writeRecord,
} from "./journal-files.js";
import {
  adminQuantumMs,
  attemptId,
  checkCompletion,
  checkManifest,
  checkState,
  requireState,
  waitReserveMs,
} from "./journal-validation.js";
import { nextSlot, resolveRates } from "./plan.js";
import { verifyOwnership } from "./ownership.js";
import {
  campaignLimits,
  type Attempt,
  type AttemptToken,
  type CampaignManifest,
  type Charge,
  type Completion,
  type JournalState,
  type Outcome,
  type Resolution,
  type VerifyResult,
  type Session,
} from "./model.js";

interface Options {
  mode: "create" | "resume";
  manifest: CampaignManifest;
  conditions: Record<string, string>;
  verifyResult: VerifyResult;
  lockFd: number;
  /** Monotonic milliseconds in this process only. */
  now?: () => number;
  startedMs?: number;
  verifyIdentity?: (checkpoint: () => Promise<void>) => Promise<void>;
}

interface SavedJournal {
  manifestHash: string;
  state: JournalState;
}

export class CampaignJournal {
  #started: number;
  readonly #now: () => number;
  readonly #data: JournalState;
  readonly #manifestHash: string;
  #closed = false;

  private constructor(
    readonly directory: string,
    private readonly options: Options,
    state: JournalState,
    started: number,
  ) {
    this.options = { ...options, manifest: structuredClone(options.manifest) };
    this.#data = state;
    this.#manifestHash = recordHash(options.manifest);
    this.#now = options.now ?? (() => performance.now());
    this.#started = started;
  }

  get state(): Readonly<JournalState> {
    return structuredClone(this.#data);
  }
  get replacements() {
    return this.#data.attempts.filter((a) => a.replaces !== undefined).length;
  }
  get remainingReservationMs() {
    const current = this.current;
    return !current || current.elapsedMs !== undefined
      ? 0
      : Math.max(0, current.reservedMs - this.elapsed());
  }
  get remainingMs() {
    return Math.max(
      0,
      campaignLimits.activeMs -
        this.#data.charges.reduce(
          (n, c) => n + (c.elapsedMs ?? this.elapsed()),
          0,
        ),
    );
  }
  private elapsed() {
    const duration = this.#now() - this.#started;
    requireState(
      Number.isFinite(duration) && duration >= 0,
      "invalid monotonic clock",
    );
    return duration;
  }
  private get current() {
    return this.#data.charges.at(-1);
  }
  private get session() {
    return this.#data.sessions.at(-1)!;
  }
  private async persist() {
    await writeRecord(
      join(this.directory, "journal.json"),
      { manifestHash: this.#manifestHash, state: this.#data },
      true,
    );
  }
  private startCharge(
    kind: Charge["kind"],
    maximum: number,
    attempt?: Attempt,
  ) {
    const available = this.remainingMs;
    const reservedMs =
      kind === "admin" ? Math.min(available, maximum) : maximum;
    requireState(
      reservedMs > 0 && available >= reservedMs,
      "insufficient active-time budget",
    );
    this.#data.charges.push({
      kind,
      sessionId: this.session.id,
      reservedMs,
      ...(attempt ? { attemptId: attempt.id } : {}),
    });
  }
  private settle(kind: Charge["kind"], elapsed = this.elapsed()) {
    const c = this.current;
    requireState(
      !this.#closed && c?.kind === kind && c.elapsedMs === undefined,
      "wrong active reservation",
    );
    c.elapsedMs = elapsed;
    this.#started += elapsed;
  }
  private token(a: Attempt): AttemptToken {
    const slot = this.options.manifest.slots.find((s) => s.id === a.slotId)!;
    const diagnostic =
      this.#data.sessions[a.sessionId - 1].clientDiagnostics?.[slot.variant];
    return {
      id: a.id,
      slot: structuredClone(slot),
      ...(diagnostic ? { clientDiagnostic: structuredClone(diagnostic) } : {}),
      rate: a.rate,
      directory: join(this.directory, "attempts", a.id),
    };
  }
  private input(a: Attempt) {
    const t = this.token(a);
    return {
      campaignId: this.options.manifest.campaignId,
      diagnosticHash: t.clientDiagnostic
        ? recordHash(t.clientDiagnostic)
        : null,
      manifestHash: this.#manifestHash,
      id: t.id,
      slot: t.slot,
      rate: t.rate,
      sessionId: a.sessionId,
      replaces: a.replaces ?? null,
    };
  }

  static async open(directory: string, options: Options) {
    const now = options.now ?? (() => performance.now());
    const started = options.startedMs ?? now();
    verifyOwnership(directory, options.lockFd);
    checkManifest(options.manifest);
    const manifestFile = join(directory, "manifest.json");
    const journalFile = join(directory, "journal.json");
    let state: JournalState = { attempts: [], sessions: [], charges: [] };
    if (options.mode === "create") {
      requireState(
        (await readdir(directory)).every((n) => n === ".lock"),
        "campaign directory must be new",
      );
      await writeRecord(manifestFile, options.manifest);
      await mkdir(join(directory, "attempts"));
    } else {
      const manifest = await readRecord<CampaignManifest>(manifestFile);
      requireState(
        isDeepStrictEqual(manifest, options.manifest),
        "campaign manifest or execution identity changed",
      );
      const saved = await readRecord<SavedJournal>(journalFile);
      requireState(
        saved.manifestHash === recordHash(options.manifest),
        "journal manifest hash",
      );
      state = saved.state;
      checkState(state, options.manifest);
      requireState(!state.stopReason, state.stopReason ?? "campaign stopped");
    }
    const journal = new CampaignJournal(directory, options, state, started);
    await journal.recover();
    journal.#data.sessions.push({
      id: state.sessions.length + 1,
      startedUtc: new Date().toISOString(),
      conditions: options.conditions,
    });
    // Charge admission work since this worker took ownership, including reading the small journal.
    journal.startCharge("admin", adminQuantumMs);
    journal.#started = started;
    await journal.persist();
    try {
      await options.verifyIdentity?.(() => journal.checkpoint());
      await journal.checkpoint();
      await journal.verifyEvidence();
    } catch (error) {
      await journal.closeSession("validation failed");
      throw error;
    }
    return journal;
  }

  /** Restore the sole unfinished reservation. Sealed output takes precedence over an old index. */
  private async recover() {
    const session = this.#data.sessions.at(-1);
    if (!session || session.endedUtc || session.recoveredUtc) return;
    const c = this.current;
    if (c && c.elapsedMs === undefined) {
      if (c.kind === "attempt") {
        const attempt = this.#data.attempts.at(-1)!;
        const dir = this.token(attempt).directory;
        const file = join(dir, "completed.json");
        if (await exists(file)) {
          const completion = await readRecord<Completion>(file);
          checkCompletion(completion, attempt.id);
          requireState(
            completion.inputHash === recordHash(this.input(attempt)),
            "completion inputs changed",
          );
          this.recordCompletion(attempt, completion);
          c.elapsedMs = completion.elapsedMs;
          // A published completion starts the next admin interval even if the runner
          // died before it refreshed the derived index.
          const reserve = Math.min(this.remainingMs, adminQuantumMs);
          if (reserve > 0)
            this.#data.charges.push({
              kind: "admin",
              sessionId: session.id,
              reservedMs: reserve,
              elapsedMs: reserve,
              interrupted: true,
            });
        } else {
          attempt.status = "interrupted";
        }
      }
      if (c.elapsedMs === undefined) {
        c.elapsedMs = c.reservedMs;
        c.interrupted = true;
      }
    }
    session.reason = "interrupted";
    // Its actual stop UTC is unknown. This is the UTC time abandonment was discovered.
    session.recoveredUtc = new Date().toISOString();
  }

  private async verifyEvidence() {
    const attemptDir = join(this.directory, "attempts");
    requireState((await lstat(attemptDir)).isDirectory(), "attempts directory");
    const ids = new Set(this.#data.attempts.map((a) => a.id));
    requireState(
      (await readdir(attemptDir)).every((n) => ids.has(n)),
      "unknown attempt directory",
    );
    for (const a of this.#data.attempts) {
      const token = this.token(a);
      const input = join(token.directory, "input.json");
      if (!(await exists(token.directory))) {
        requireState(a.status === "interrupted", "missing attempt directory");
        continue;
      }
      requireState(
        (await lstat(token.directory)).isDirectory(),
        "attempt directory type",
      );
      if (await exists(input))
        requireState(
          isDeepStrictEqual(await readRecord(input), this.input(a)),
          "attempt inputs changed",
        );
      else requireState(a.status === "interrupted", "missing attempt input");
      if (a.status !== "completed") continue;
      const c = await readRecord<Completion>(
        join(token.directory, "completed.json"),
      );
      requireState(
        c.inputHash === recordHash(this.input(a)) &&
          isDeepStrictEqual(c, a.completion) &&
          recordHash(c) === a.completionHash,
        "completion record changed",
      );
      const artifacts = await inventory(
        token.directory,
        c.artifacts.map((x) => x.name),
        true,
        () => this.checkpoint(),
      );
      requireState(
        isDeepStrictEqual(artifacts, c.artifacts),
        "artifact hash mismatch",
      );
      await this.options.verifyResult(token, c, () => this.checkpoint());
    }
  }

  async checkpoint() {
    const c = this.current;
    requireState(
      !this.#closed && c && c.elapsedMs === undefined,
      "closed reservation",
    );
    const duration = this.elapsed();
    if (duration > c.reservedMs) {
      this.#data.stopReason = `Campaign ${c.kind} reservation expired`;
      await this.closeSession(this.#data.stopReason);
      throw new Error(this.#data.stopReason);
    }
    if (c.kind === "admin" && duration >= c.reservedMs / 2) {
      this.settle("admin", duration);
      this.startCharge("admin", adminQuantumMs);
      await this.persist();
    }
  }
  async recordDiagnostics(results: NonNullable<Session["clientDiagnostics"]>) {
    await this.checkpoint();
    requireState(
      this.current?.kind === "admin" &&
        !this.session.clientDiagnostics &&
        !this.#data.attempts.some((a) => a.sessionId === this.session.id),
      "session diagnostics already recorded or not in administration",
    );
    this.session.clientDiagnostics = structuredClone(results);
    await this.persist();
  }

  async reserveWait() {
    await this.checkpoint();
    requireState(
      this.remainingMs >= waitReserveMs,
      "insufficient settling time budget",
    );
    this.settle("admin");
    this.startCharge("wait", waitReserveMs);
    await this.persist();
  }
  async finishWait() {
    await this.checkpoint();
    requireState(
      this.elapsed() >= campaignLimits.settleMs,
      "settling wait is incomplete",
    );
    this.settle("wait");
    this.startCharge("admin", adminQuantumMs);
    await this.persist();
  }
  async reserveAttempt(slotId: string, rate: number) {
    await this.checkpoint();
    const slot = this.options.manifest.slots.find((s) => s.id === slotId);
    requireState(
      slot &&
        (slot.baselineRate ?? this.#data.resolution?.rates[slot.storage]) ===
          rate,
      "slot rate",
    );
    const prior = this.#data.attempts.findLast((a) => a.slotId === slotId);
    requireState(
      !prior ||
        prior.status === "interrupted" ||
        prior.completion?.outcome === "infrastructure",
      "completed slot cannot be repeated",
    );
    requireState(
      !prior || this.replacements < campaignLimits.replacements,
      "replacement allowance exhausted",
    );
    requireState(
      this.remainingMs >= campaignLimits.attemptMs,
      "insufficient attempt time budget",
    );
    const next = nextSlot(this.options.manifest, this.#data, this.replacements);
    requireState(
      next && "slot" in next && next.slot?.id === slotId && next.rate === rate,
      "attempt violates frozen schedule",
    );
    this.settle("admin");
    const a: Attempt = {
      id: attemptId(this.#data.attempts.length),
      slotId,
      rate,
      sessionId: this.session.id,
      status: "running",
      ...(prior ? { replaces: prior.id } : {}),
    };
    this.#data.attempts.push(a);
    this.startCharge("attempt", campaignLimits.attemptMs, a);
    await this.persist();
    const token = this.token(a);
    await mkdir(token.directory);
    await writeRecord(join(token.directory, "input.json"), this.input(a));
    return token;
  }

  private recordCompletion(a: Attempt, c: Completion) {
    a.status = "completed";
    a.completion = c;
    a.completionHash = recordHash(c);
  }
  async finishAttempt(
    token: AttemptToken,
    result: { outcome: Outcome; reason: string; artifacts: string[] },
  ) {
    await this.checkpoint();
    const a = this.#data.attempts.at(-1);
    requireState(
      a?.id === token.id &&
        a.status === "running" &&
        isDeepStrictEqual(this.token(a), token),
      "wrong attempt to complete",
    );
    const artifacts = await inventory(
      token.directory,
      result.artifacts,
      false,
      () => this.checkpoint(),
    );
    const c: Completion = {
      id: a.id,
      inputHash: recordHash(this.input(a)),
      outcome: result.outcome,
      reason: result.reason,
      artifacts,
      elapsedMs: this.elapsed(),
    };
    checkCompletion(c, a.id);
    await this.options.verifyResult(token, c, () => this.checkpoint());
    await this.checkpoint();
    c.elapsedMs = this.elapsed();
    await writeRecord(join(token.directory, "completed.json"), c);
    this.recordCompletion(a, c);
    this.settle("attempt", c.elapsedMs);
    this.startCharge("admin", adminQuantumMs);
    await this.persist();
  }

  async saveResolution(resolution: Resolution) {
    await this.checkpoint();
    requireState(
      this.current?.kind === "admin",
      "comparison selection during an attempt",
    );
    if (this.#data.resolution) {
      requireState(
        isDeepStrictEqual(this.#data.resolution, resolution),
        "comparison rate already frozen",
      );
      return;
    }
    const next = nextSlot(this.options.manifest, this.#data, this.replacements);
    requireState(
      next?.needsResolution &&
        isDeepStrictEqual(
          resolveRates(this.options.manifest, this.#data),
          resolution,
        ),
      "comparison resolution does not match baseline evidence",
    );
    this.#data.resolution = structuredClone(resolution);
    checkState(this.#data, this.options.manifest);
    await this.persist();
  }
  async closeSession(reason: string) {
    if (this.#closed) return;
    const c = this.current!;
    // A successful seal is authoritative even if publishing the derived index failed.
    if (c.kind === "attempt" && c.elapsedMs === undefined) {
      const last = this.#data.attempts.at(-1)!;
      const seal = join(this.token(last).directory, "completed.json");
      if (await exists(seal)) {
        await this.recover();
        this.#closed = true;
        await this.persist();
        return;
      }
    }
    requireState(
      c.elapsedMs === undefined,
      "session has no active reservation",
    );
    if (c.kind === "attempt") {
      this.#data.attempts.at(-1)!.status = "interrupted";
      c.interrupted = true;
    }
    if (c.kind === "wait") c.interrupted = true;
    const elapsed = this.elapsed();
    if (elapsed > c.reservedMs)
      this.#data.stopReason ??= `Campaign ${c.kind} reservation expired`;
    this.settle(c.kind, elapsed);
    this.session.endedUtc = new Date().toISOString();
    this.session.reason = reason;
    this.#closed = true;
    await this.persist();
  }
}
export const openCampaign = CampaignJournal.open;
