// Baseline change-to-check map. Unknown code selects all suites.
export const suites = [
  "java",
  "static",
  "core",
  "demo",
  "browser",
  "native",
  "engines",
  "reconnect",
];
const javaRoot = "zooglass/src/main/java/io/zooglass/";
const internalJava = new Set(
  [
    "runtime/BoundView.java",
    "runtime/ClockRollback.java",
    "runtime/ViewTransitions.java",
    "runtime/ConfigurationValidation.java",
    "runtime/RuntimeConfiguration.java",
  ].map((file) => javaRoot + file),
);
const protocolJava = new Set(
  [
    "api/ViewSnapshot.java",
    "runtime/ViewCoordinator.java",
    "runtime/RuntimeEndpoints.java",
    "runtime/EventIngress.java",
    "runtime/ProgressIngress.java",
    "runtime/FactRetirementIngress.java",
  ].map((file) => javaRoot + file),
);

export function isDocumentation(path) {
  return (
    /\.md$/.test(path) ||
    /^(docs\/|(?:zooglass|workbench|demos\/[^/]+)\/docs\/).*\.(svg|png|jpg|jpeg|gif|webp|mp4)$/.test(
      path,
    ) ||
    ["LICENSE", "SECURITY.md"].includes(path)
  );
}

export function selectChecks(paths, { forceFull = false } = {}) {
  const plan = Object.fromEntries(suites.map((name) => [name, false]));
  const reasons = [];
  const add = (names, path) => {
    for (const name of names) {
      plan[name] = true;
    }
    reasons.push(`${path}: ${names.join(", ")}`);
  };
  for (const path of paths) {
    if (isDocumentation(path)) continue;
    if (/^zooglass\/src\/test\/.*\.java$/.test(path)) {
      add(["java"], path);
    } else if (
      /^zooglass\/src\/main\/java\/io\/zooglass\/strategy\/(?:contribution|fact|freshness|identity|late|progress|publication|update)\/[^/]+\.java$/.test(
        path,
      )
    ) {
      add(["java", "core"], path);
    } else if (internalJava.has(path)) {
      add(["java", "core"], path);
    } else if (
      protocolJava.has(path) ||
      /^zooglass\/src\/main\/java\/io\/zooglass\/delivery\/[^/]+\.java$/.test(
        path,
      )
    ) {
      add(["java", "core", "browser"], path);
    } else if (/^workbench\/src\/(scenario|execution)\/.*\.ts$/.test(path)) {
      add(["static", "core"], path);
    } else if (
      /^workbench\/src\/demos\/orders\/(?:application|browser|main|interactive|checkpoints|source-session)\.ts$/.test(
        path,
      ) ||
      path === "workbench/src/cli/demo.ts"
    ) {
      add(["static", "core", "demo", "browser", "native", "engines"], path);
    } else if (/^workbench\/src\/demos\/orders\/.*\.ts$/.test(path)) {
      add(["static", "core"], path);
    } else if (/^workbench\/src\/service\//.test(path)) {
      add(["static", "core", "demo", "browser", "native"], path);
    } else if (
      /^workbench\/(src\/(browser|control|demos\/vehicle)|browser)\//.test(path)
    ) {
      add(["static", "core", "demo", "browser", "native", "engines"], path);
    } else if (
      /^demos\/(?:vehicle-tracker|order-tracker)\/(src|pages)\//.test(path) ||
      /^workbench\/scenarios\//.test(path)
    ) {
      add(["static", "core", "demo", "browser", "engines"], path);
    } else if (/^workbench\/test\/demo-unit\/[^/]+\.test\.ts$/.test(path)) {
      add(["static", "demo"], path);
    } else if (/^workbench\/test\/browser\/[^/]+\.test\.ts$/.test(path)) {
      add(["static", "browser"], path);
    } else if (/^workbench\/test\/platform\/[^/]+\.test\.ts$/.test(path)) {
      add(["static", "engines"], path);
    } else if (path === "workbench/test/support/live-client.ts") {
      add(["static", "core", "reconnect"], path);
    } else if (path === "workbench/test/resources/reconnect.test.ts") {
      add(["static", "reconnect"], path);
    } else if (/^workbench\/test\/resources\/[^/]+\.test\.ts$/.test(path)) {
      add(["static", "browser", "native"], path);
    } else if (
      /^workbench\/test\/(?:scenarios\/)?[^/]+\.test\.ts$/.test(path) &&
      path !== "workbench/test/prebuilt-service.test.ts"
    ) {
      add(["static", "core"], path);
    } else {
      // Includes shared helpers, build files, lockfiles, CI and new/unmapped modules.
      add(suites, path);
    }
  }
  if (forceFull) add(suites, "Full validation requested");
  return { ...plan, reasons, paths };
}

export function requiredResultErrors(plan, results, groups) {
  const errors = [];
  for (const [job, selectedSuites] of Object.entries(groups)) {
    if (
      selectedSuites.some((name) => plan[name]) &&
      results[job]?.result !== "success"
    ) {
      errors.push(`${job}: required but ${results[job]?.result ?? "missing"}`);
    }
  }
  return errors;
}
