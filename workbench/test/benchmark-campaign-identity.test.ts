import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treeHash } from "../src/benchmark/campaign/identity.js";
import {
  startupFailure,
  startupOutcome,
} from "../src/benchmark/campaign/model.js";

test(
  "installed dependency edits change identity even with an unchanged package lock",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zooglass-frozen-deps-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const root = join(dir, "node_modules");
    await mkdir(join(root, ".bin"), { recursive: true });
    const code = join(root, "runtime.js");
    await writeFile(code, "original");
    await symlink("../runtime.js", join(root, ".bin", "runtime"));
    const before = await treeHash(root);
    await writeFile(code, "same lockfile; different executable bytes");
    assert.notEqual(await treeHash(root), before);
    await symlink(dir, join(root, "escaped"));
    await assert.rejects(treeHash(root), /leaves the frozen tree/);
  },
);

test("replacement eligibility requires OS evidence of service spawn failure", () => {
  assert.equal(
    startupOutcome(
      startupFailure(
        Object.assign(new Error("launch"), {
          code: "EAGAIN",
          syscall: "spawn java",
        }),
      ),
    ),
    "infrastructure",
  );
  assert.equal(
    startupOutcome(startupFailure(new Error("spawn java EAGAIN"))),
    "correctness",
  );
  assert.equal(
    startupOutcome(
      startupFailure(
        Object.assign(new Error("read"), { code: "ENOENT", syscall: "open" }),
      ),
    ),
    "correctness",
  );
});
