import assert from "node:assert/strict";
import test from "node:test";
import {
  checkOrderControl,
  verifyOrderDelta,
} from "../../scripts/order-control-check.js";
import type { DocumentRun } from "../../src/timeline/campaign-checks.js";

for (const name of ["priority", "clock"] as const)
  test(`${name} control requires its intended semantic assertion, not startup failure or any divergence`, () => {
    const normal = { outcome: "passed" } as DocumentRun;
    for (const outcome of ["passed", "unsupported", "infrastructure-failed"]) {
      const wrong = { outcome } as DocumentRun;
      assert.throws(
        () => checkOrderControl(name, normal, wrong, wrong),
        /mutant must fail semantically/,
      );
    }
    const unrelated = {
      outcome: "assertion-failed",
      message: "assertion-failed: unrelated",
    } as DocumentRun;
    assert.throws(
      () => checkOrderControl(name, normal, unrelated, unrelated),
      /assertion-failed:/,
    );
  });

test("Order control inventories reject concealed, extra and missing changed classes", () => {
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
  verifyOrderDelta(
    normal,
    mutant,
    ["metadata", "target"],
    ["target"],
    "metadata",
  );
  assert.throws(
    () => verifyOrderDelta(normal, mutant, ["target"], ["target"], "metadata"),
    /actual bytes/,
  );
  mutant.set("other", "changed");
  assert.throws(
    () =>
      verifyOrderDelta(
        normal,
        mutant,
        ["metadata", "other", "target"],
        ["target"],
        "metadata",
      ),
    /unexpected artifact class/,
  );
  mutant.delete("other");
  assert.throws(
    () => verifyOrderDelta(normal, mutant, [], ["target"], "metadata"),
    /layouts differ/,
  );
  assert.throws(
    () => verifyOrderDelta(normal, normal, [], ["target"], "metadata"),
    /unexpected artifact class/,
  );
});
