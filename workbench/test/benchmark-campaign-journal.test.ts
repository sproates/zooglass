import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { writeObservations } from "../src/benchmark/campaign/evidence.js";
import { baseline } from "../src/benchmark/workload.js";
import { openCampaign } from "../src/benchmark/campaign/journal.js";
import {
  campaignLimits,
  type CampaignManifest,
  type Outcome,
} from "../src/benchmark/campaign/model.js";
import {
  readRecord,
  writeRecord,
} from "../src/benchmark/campaign/journal-files.js";

const posix = { skip: !["linux", "darwin"].includes(process.platform) };

async function fixture(t: TestContext, slots = 3) {
  const directory = await mkdtemp(join(tmpdir(), "zooglass-journal-"));
  const fd = await open(join(directory, ".lock"), "wx+");
  t.after(async () => {
    await fd.close();
    await rm(directory, { recursive: true, force: true });
  });
  const manifest: CampaignManifest = {
    format: "benchmark-campaign/v1",
    campaignId: "fixture",
    identity: { jar: "original" },
    selectionRule: "fixture",
    limits: campaignLimits,
    slots: Array.from({ length: slots }, (_, index) => ({
      id: "slot-" + (index + 1),
      storage: "memory",
      replicate: (index % 3) + 1,
      variant: "baseline",
      baselineRate: 10,
      workload: baseline,
    })),
  };
  let now = 0,
    checked = 0;
  const options = {
    manifest,
    conditions: { load: "fixture" },
    lockFd: fd.fd,
    now: () => now,
    verifyResult: async (
      token: { directory: string },
      c: { outcome: Outcome },
    ) => {
      checked++;
      assert.equal(
        await readFile(join(token.directory, "result.json"), "utf8"),
        c.outcome,
      );
    },
  };
  const create = () => openCampaign(directory, { ...options, mode: "create" });
  const resume = () => openCampaign(directory, { ...options, mode: "resume" });
  return {
    directory,
    options,
    create,
    resume,
    tick: (ms: number) => {
      now += ms;
    },
    checks: () => checked,
  };
}

test(
  "terminal failures skip and resume validates identities, inventory and accounting before new work",
  posix,
  async (t) => {
    const f = await fixture(t);
    const j = await f.create();
    f.tick(1_000);
    const a = await j.reserveAttempt("slot-1", 10);
    await writeFile(join(a.directory, "result.json"), "correctness");
    f.tick(220);
    await j.finishAttempt(a, {
      outcome: "correctness",
      reason: "wrong value",
      artifacts: ["result.json"],
    });
    await j.closeSession("pause");
    f.tick(4 * 60 * 60_000);
    await assert.rejects(
      openCampaign(f.directory, {
        ...f.options,
        mode: "resume",
        manifest: { ...f.options.manifest, identity: { jar: "different" } },
      }),
      /identity changed/,
    );
    const resumed = await f.resume();
    assert.equal(f.checks(), 2);
    assert.equal(resumed.remainingMs, campaignLimits.activeMs - 1220);
    await assert.rejects(
      resumed.reserveAttempt("slot-1", 10),
      /cannot be repeated/,
    );
    await assert.rejects(
      resumed.reserveAttempt("slot-3", 10),
      /frozen schedule/,
    );
    await resumed.closeSession("pause");
    await writeFile(join(a.directory, "result.json"), "other");
    await assert.rejects(f.resume(), /artifact hash mismatch/);
    await writeFile(join(a.directory, "result.json"), "correctness");
    await writeFile(join(a.directory, "unexpected.json"), "extra");
    await assert.rejects(f.resume(), /inventory/);
  },
);

test(
  "prelaunch, mid-measurement and partial output crashes retain one shared replacement debit",
  posix,
  async (t) => {
    const f = await fixture(t);
    let j = await f.create();
    for (let i = 0; i < 7; i++) {
      const a = await j.reserveAttempt("slot-1", 10);
      if (i === 0) await rm(a.directory, { recursive: true });
      else
        await writeFile(
          join(a.directory, "partial.jsonl"),
          "an unfinished write",
        );
      j = await f.resume();
      assert.equal(j.replacements, i);
      assert.equal(j.state.attempts[i].status, "interrupted");
      if (i)
        assert.equal(
          await readFile(join(a.directory, "partial.jsonl"), "utf8"),
          "an unfinished write",
        );
    }
    await assert.rejects(j.reserveAttempt("slot-1", 10), /allowance exhausted/);
    await j.closeSession("pause");
    const again = await f.resume();
    assert.equal(
      again.remainingMs,
      campaignLimits.activeMs - 7 * campaignLimits.attemptMs,
    );
    assert.equal(again.replacements, 6);
  },
);

test(
  "sealed output before index update is verified, accounted once and skipped on repeated resume",
  posix,
  async (t) => {
    const f = await fixture(t);
    const j = await f.create();
    const a = await j.reserveAttempt("slot-1", 10);
    const index = join(f.directory, "journal.json");
    const previous = await readFile(index);
    await writeFile(join(a.directory, "result.json"), "pass");
    f.tick(150);
    await j.finishAttempt(a, {
      outcome: "pass",
      reason: "",
      artifacts: ["result.json"],
    });
    await writeFile(index, previous);
    const resumed = await f.resume();
    assert.equal(resumed.state.attempts[0].completion?.elapsedMs, 150);
    assert.equal(resumed.remainingMs, campaignLimits.activeMs - 150 - 60_000);
    await assert.rejects(
      resumed.reserveAttempt("slot-1", 10),
      /cannot be repeated/,
    );
    await resumed.closeSession("pause");
    const again = await f.resume();
    assert.equal(again.remainingMs, resumed.remainingMs);
    assert.equal(again.replacements, 0);
  },
);

test(
  "exclusive reservations settle elapsed time and preserve interrupted admin and wait budgets",
  posix,
  async (t) => {
    const f = await fixture(t);
    let j = await f.create();
    f.tick(31_000);
    await j.checkpoint();
    j = await f.resume();
    assert.equal(j.remainingMs, campaignLimits.activeMs - 91_000);
    await j.reserveWait();
    f.tick(20_000);
    await assert.rejects(j.finishWait(), /incomplete/);
    j = await f.resume();
    assert.equal(j.remainingMs, campaignLimits.activeMs - 151_000);
    await j.reserveWait();
    f.tick(30_005);
    await j.finishWait();
    assert.equal(j.remainingMs, campaignLimits.activeMs - 181_005);
    await j.closeSession("intentionally paused");
    assert.equal(j.state.sessions.at(-1)?.reason, "intentionally paused");
  },
);

test(
  "foreign paths, symlinked evidence and inconsistent debit records are rejected",
  posix,
  async (t) => {
    const f = await fixture(t);
    const j = await f.create();
    const a = await j.reserveAttempt("slot-1", 10);
    await assert.rejects(
      j.finishAttempt(a, {
        outcome: "pass",
        reason: "",
        artifacts: ["../outside"],
      }),
      /artifact names/,
    );
    await symlink(
      join(f.directory, "manifest.json"),
      join(a.directory, "result.json"),
    );
    await assert.rejects(
      j.finishAttempt(a, {
        outcome: "pass",
        reason: "",
        artifacts: ["result.json"],
      }),
      /ELOOP/,
    );
    await j.closeSession("fixture stop");
    const path = join(f.directory, "journal.json");
    const saved = await readRecord<{ state: { charges: unknown[] } }>(path);
    saved.state.charges.pop();
    await writeRecord(path, saved, true);
    await assert.rejects(f.resume(), /missing attempt reservations/);
  },
);

test(
  "remaining active budget cannot admit another full attempt or settling wait",
  posix,
  async (t) => {
    const f = await fixture(t, 17);
    const j = await f.create();
    for (let i = 1; i <= 16; i++) {
      const a = await j.reserveAttempt("slot-" + i, 10);
      await writeFile(join(a.directory, "result.json"), "pass");
      f.tick(campaignLimits.attemptMs - 3000);
      await j.finishAttempt(a, {
        outcome: "pass",
        reason: "",
        artifacts: ["result.json"],
      });
    }
    assert.equal(j.remainingMs, 48_000);
    await assert.rejects(j.reserveWait(), /insufficient/);
    await assert.rejects(j.reserveAttempt("slot-17", 10), /insufficient/);
    await j.closeSession("budget exhausted for remaining work");
    const resumed = await f.resume();
    assert.equal(resumed.remainingMs, 48_000);
  },
);

test(
  "a known overrun stops later sessions and cannot reset the capped budget",
  posix,
  async (t) => {
    const f = await fixture(t);
    const j = await f.create();
    await j.reserveAttempt("slot-1", 10);
    f.tick(campaignLimits.attemptMs + 1);
    await assert.rejects(j.checkpoint(), /attempt reservation expired/);
    await assert.rejects(f.resume(), /attempt reservation expired/);
  },
);

test(
  "stored comparison selection and duration debits must reproduce even with a rewritten envelope",
  posix,
  async (t) => {
    const f = await fixture(t);
    const j = await f.create();
    await j.closeSession("pause");
    const path = join(f.directory, "journal.json");
    const saved = await readRecord<{
      state: import("../src/benchmark/campaign/model.js").JournalState;
    }>(path);
    saved.state.resolution = {
      rates: { memory: 10, sqlite: null },
      evidence: {},
    };
    await writeRecord(path, saved, true);
    await assert.rejects(f.resume(), /comparison resolution/);
    delete saved.state.resolution;
    saved.state.charges[0].elapsedMs = saved.state.charges[0].reservedMs + 1;
    await writeRecord(path, saved, true);
    await assert.rejects(f.resume(), /settled duration exceeds/);
  },
);

test(
  "the attempt deadline covers output writing and retains the unfinished prefix",
  posix,
  async (t) => {
    const f = await fixture(t);
    const j = await f.create();
    const a = await j.reserveAttempt("slot-1", 10);
    f.tick(campaignLimits.attemptMs - 100);
    assert.equal(j.remainingReservationMs, 100);
    function* chunks() {
      yield Buffer.from("first\n");
      f.tick(101);
      yield Buffer.from("beyond deadline\n");
    }
    const output = join(a.directory, "partial.jsonl");
    await assert.rejects(
      writeObservations(output, chunks(), () => j.checkpoint()),
      /reservation expired/,
    );
    assert.equal(await readFile(output, "utf8"), "first\n");
    assert.equal(j.state.attempts[0].status, "interrupted");
    await assert.rejects(f.resume(), /reservation expired/);
  },
);
