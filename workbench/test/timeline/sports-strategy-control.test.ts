import assert from "node:assert/strict";
import test from "node:test";
import {
  checkSportsStrategyControl,
  verifySportsDelta,
} from "../../scripts/sports-strategy-check.js";
import type { DocumentRun } from "../../src/timeline/campaign-checks.js";

test("Sports wrong-revision control rejects startup failure and unrelated assertions", () => {
  const normal = { outcome: "passed" } as DocumentRun;
  for (const outcome of ["passed", "unsupported", "infrastructure-failed"]) {
    const wrong = { outcome } as DocumentRun;
    assert.throws(
      () => checkSportsStrategyControl(normal, wrong, wrong),
      /mutant must fail semantically/,
    );
  }
  const unrelated = {
    outcome: "assertion-failed",
    message: "assertion-failed: unrelated",
  } as DocumentRun;
  assert.throws(
    () => checkSportsStrategyControl(normal, unrelated, unrelated),
    /assertion-failed:/,
  );
});

test("Sports control inventories reject concealed, extra and missing changed classes", () => {
  const normal = new Map([
    ["target", "normal"],
    ["other", "unchanged"],
    ["metadata", "old"],
  ]);
  const mutant = new Map([
    ["target", "mutant"],
    ["other", "unchanged"],
    ["metadata", "new"],
  ]);
  verifySportsDelta(
    normal,
    mutant,
    ["metadata", "target"],
    "target",
    "metadata",
  );
  assert.throws(
    () => verifySportsDelta(normal, mutant, ["target"], "target", "metadata"),
    /actual artifact delta/,
  );
  mutant.set("other", "changed");
  assert.throws(
    () =>
      verifySportsDelta(
        normal,
        mutant,
        ["metadata", "other", "target"],
        "target",
        "metadata",
      ),
    /unexpected class/,
  );
  mutant.delete("other");
  assert.throws(
    () => verifySportsDelta(normal, mutant, [], "target", "metadata"),
    /layouts differ/,
  );
  assert.throws(
    () => verifySportsDelta(normal, normal, [], "target", "metadata"),
    /unexpected class/,
  );
});
