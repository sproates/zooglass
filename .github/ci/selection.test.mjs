import { existsSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { selectChecks, suites, requiredResultErrors } from "./selection.mjs";
const selected = (paths) => suites.filter((name) => selectChecks(paths)[name]);
test("documentation anywhere is cheap, including archived images", () => {
  assert.deepEqual(
    selected([
      "README.md",
      "zooglass/README.md",
      "workbench/docs/source-map.md",
      "demos/vehicle-tracker/docs/run.png",
      "docs/diagrams/overview.svg",
    ]),
    [],
  );
});
test("Java assertions need Java; core policy needs real service tests", () => {
  assert.deepEqual(
    selected(["zooglass/src/test/java/io/zooglass/ViewStoreTests.java"]),
    ["java"],
  );
  assert.deepEqual(
    selected(["zooglass/src/main/java/io/zooglass/runtime/ClockRollback.java"]),
    ["java", "core"],
  );
});
test("protocol changes retain browser consumer verification", () => {
  assert.deepEqual(
    selected([
      "zooglass/src/main/java/io/zooglass/delivery/OutboundWriter.java",
    ]),
    ["java", "core", "browser"],
  );
});
test("UI changes check consumers but do not rerun Java tests", () => {
  assert.deepEqual(selected(["demos/vehicle-tracker/pages/basic/index.html"]), [
    "static",
    "core",
    "demo",
    "browser",
    "engines",
  ]);
});
test("mixed paths union checks; unknown modules, helpers and fixtures are conservative", () => {
  for (const path of [
    "zooglass/src/main/java/io/zooglass/NewStrategy.java",
    "workbench/test/support/new-helper.ts",
    "zooglass/src/main/resources/views.json",
    "workbench/package-lock.json",
    ".github/workflows/ci.yml",
    "old-location/app.ts",
  ]) {
    assert.deepEqual(selected([path]), suites);
  }
  assert.deepEqual(
    selected([
      "zooglass/src/main/java/io/zooglass/runtime/ViewTransitions.java",
      "demos/vehicle-tracker/src/view.ts",
    ]),
    ["java", "static", "core", "demo", "browser", "engines"],
  );
});
test("deleted and renamed paths remain inputs; executable JSON is not documentation", () => {
  assert.deepEqual(
    selected(["old-location/app.ts", "demos/vehicle-tracker/src/view.ts"]),
    suites,
  );
  assert.ok(
    selectChecks(["workbench/scenarios/vehicle-browser-basic.json"]).browser,
  );
});
test("forced full selection overrides empty and docs-only diffs", () => {
  for (const paths of [[], ["README.md"]]) {
    const plan = selectChecks(paths, { forceFull: true });
    assert.ok(suites.every((name) => plan[name]));
  }
});
test("gate rejects failed, cancelled, skipped and missing selected jobs", () => {
  const plan = selectChecks([
    "zooglass/src/main/java/io/zooglass/runtime/ViewTransitions.java",
  ]);
  const groups = {
    java: ["java"],
    standard: ["core", "demo", "static"],
    browser: ["browser"],
  };
  for (const result of ["failure", "cancelled", "skipped", undefined]) {
    assert.ok(
      requiredResultErrors(
        plan,
        { java: { result: "success" }, standard: { result } },
        groups,
      ).length,
    );
  }
  assert.deepEqual(
    requiredResultErrors(
      plan,
      { java: { result: "success" }, standard: { result: "success" } },
      groups,
    ),
    [],
  );
});

test("accepted update-strategy namespace keeps core validation on new modules", () => {
  assert.deepEqual(
    selected([
      "zooglass/src/main/java/io/zooglass/strategy/update/LatestBySequence.java",
    ]),
    ["java", "core"],
  );
  assert.deepEqual(
    selected([
      "zooglass/src/main/java/io/zooglass/strategy/unknown/NewStrategy.java",
    ]),
    suites,
  );
});

test("unclassified text fixtures are not mistaken for documentation", () => {
  assert.deepEqual(selected(["workbench/test/fixtures/source.txt"]), suites);
});

test("current runtime and snapshot contract paths select their suites", () => {
  for (const [relative, expected] of [
    ["runtime/ViewCoordinator.java", ["java", "core", "browser"]],
    ["runtime/ClockRollback.java", ["java", "core"]],
    ["api/ViewSnapshot.java", ["java", "core", "browser"]],
    ["delivery/OutboundWriter.java", ["java", "core", "browser"]],
  ]) {
    const path = "zooglass/src/main/java/io/zooglass/" + relative;
    assert.ok(existsSync(new URL("../../" + path, import.meta.url)));
    assert.deepEqual(selected([path]), expected);
  }
});

test("client recovery acceptance selects the Java and socket consumers", () => {
  const acceptance = [
    "ROADMAP.md",
    "docs/design/client-delivery.md",
    "docs/testing.md",
    "workbench/test/concurrent-clients.test.ts",
    "workbench/test/support/live-client.ts",
    "zooglass/src/test/java/io/zooglass/runtime/ClientRecoveryAcceptanceTests.java",
    "zooglass/src/test/java/io/zooglass/runtime/SnapshotDeliveryTests.java",
  ];
  assert.deepEqual(selected(acceptance), [
    "java",
    "static",
    "core",
    "reconnect",
  ]);
  assert.deepEqual(selected(["workbench/test/resources/reconnect.test.ts"]), [
    "static",
    "reconnect",
  ]);
  assert.deepEqual(selected(["workbench/test/resources/reset.test.ts"]), [
    "static",
    "browser",
    "native",
  ]);
});

test("fact strategies and delivery queues select their service consumers", () => {
  const root = "zooglass/src/main/java/io/zooglass/";
  assert.deepEqual(selected([root + "strategy/fact/SumActiveFacts.java"]), [
    "java",
    "core",
  ]);
  assert.deepEqual(selected([root + "delivery/OutboundQueue.java"]), [
    "java",
    "core",
    "browser",
  ]);
});

test("Order UI and launcher retain consumer and lifecycle checks", () => {
  assert.deepEqual(selected(["demos/order-tracker/src/view.ts"]), [
    "static",
    "core",
    "demo",
    "browser",
    "engines",
  ]);
  assert.deepEqual(selected(["workbench/src/demos/orders/browser.ts"]), [
    "static",
    "core",
    "demo",
    "browser",
    "native",
    "engines",
  ]);
  assert.deepEqual(selected(["workbench/src/cli/demo.ts"]), [
    "static",
    "core",
    "demo",
    "browser",
    "native",
    "engines",
  ]);
});

test("Order interactive checks and shared source delivery retain browser consumers", () => {
  for (const file of [
    "interactive",
    "checkpoints",
    "source-session",
    "run",
    "recovery",
  ]) {
    assert.deepEqual(selected([`workbench/src/demos/orders/${file}.ts`]), [
      "static",
      "core",
      "demo",
      "browser",
      "native",
      "engines",
    ]);
  }
});

test("Sports source foundation and browser composition select their consumers", () => {
  for (const module of [
    "configuration",
    "timeline",
    "receipts",
    "source-session",
    "producer",
    "simulation",
    "main",
  ]) {
    assert.deepEqual(selected([`workbench/src/demos/sports/${module}.ts`]), [
      "static",
      "core",
    ]);
  }
  for (const module of ["browser", "interactive", "run", "checkpoints"])
    assert.deepEqual(selected([`workbench/src/demos/sports/${module}.ts`]), [
      "static",
      "core",
      "demo",
      "browser",
      "native",
      "engines",
    ]);
  assert.deepEqual(selected(["demos/live-sports/src/view.ts"]), [
    "static",
    "core",
    "demo",
    "browser",
    "engines",
  ]);
  assert.deepEqual(
    selected(["workbench/src/demos/sports/new-module.ts"]),
    suites,
  );
});
