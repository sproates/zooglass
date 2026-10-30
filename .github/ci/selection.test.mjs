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
    selected(["zooglass/src/main/java/io/zooglass/FieldUpdates.java"]),
    ["java", "core"],
  );
});
test("protocol changes retain browser consumer verification", () => {
  assert.deepEqual(
    selected(["zooglass/src/main/java/io/zooglass/LiveViewBroadcaster.java"]),
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
    "workbench/test/support/live-client.ts",
    "zooglass/src/main/resources/views.json",
    "workbench/package-lock.json",
    ".github/workflows/ci.yml",
    "old-location/app.ts",
  ]) {
    assert.deepEqual(selected([path]), suites);
  }
  assert.deepEqual(
    selected([
      "zooglass/src/main/java/io/zooglass/ViewStore.java",
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
    "zooglass/src/main/java/io/zooglass/ViewStore.java",
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
