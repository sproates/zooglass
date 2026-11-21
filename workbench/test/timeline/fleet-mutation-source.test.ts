import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { mutateLatestSelection } from "../../scripts/fleet-strategy-check.js";

// Check the preparation recipe without invoking either of its Java builds.
test("fleet mutation recipe still matches the production strategy", async () => {
  const source = new URL(
    "../../../zooglass/src/main/java/io/zooglass/strategy/update/LatestBySequence.java",
    import.meta.url,
  );
  const recipe = new URL(
    "../../scripts/prepare-fleet-strategy-mutation.py",
    import.meta.url,
  );
  const original = await readFile(source, "utf8");
  const mutated = execFileSync(
    "python3",
    [
      "-c",
      `
import pathlib, runpy, sys
recipe = runpy.run_path(sys.argv[1])
source = pathlib.Path(sys.argv[2]).read_bytes()
assert source.count(recipe['BEFORE']) == 1, 'LatestBySequence mutation site changed'
sys.stdout.buffer.write(source.replace(recipe['BEFORE'], recipe.get('AFTER', b'')))
`,
      fileURLToPath(recipe),
      fileURLToPath(source),
    ],
    { encoding: "utf8" },
  );
  assert.equal(mutated, mutateLatestSelection(original));
  assert.throws(
    () => mutateLatestSelection(original + original),
    /mutation site changed/,
  );
  assert.throws(
    () => mutateLatestSelection("changed strategy"),
    /mutation site changed/,
  );
  assert.notEqual(mutated, original);
  assert.doesNotMatch(mutated, /SequenceValues\.compare/);
});
