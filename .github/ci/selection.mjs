// Baseline change-to-check map. Unknown code selects all suites.
export const suites = [
  "java",
  "static",
  "core",
  "demo",
  "browser",
  "native",
  "engines",
];
const internalJava = new Set([
  "FieldUpdates",
  "ViewStore",
  "ViewDefinitions",
  "ViewConfiguration",
]);
const protocolJava = new Set([
  "ViewSnapshot",
  "ViewController",
  "LiveViewWebSocketHandler",
  "EventLoggingWebSocketHandler",
  "LiveViewBroadcaster",
  "OutboundWriter",
  "SubscriptionIndex",
]);

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
      /^zooglass\/src\/main\/java\/io\/zooglass\/strategy\/update\/[^/]+\.java$/.test(
        path,
      )
    ) {
      // The accepted first strategy slice is pure field-update policy.
      add(["java", "core"], path);
    } else if (
      /^zooglass\/src\/main\/java\/io\/zooglass\/[^/]+\.java$/.test(path)
    ) {
      const name = path.split("/").at(-1).replace(".java", "");
      if (internalJava.has(name)) add(["java", "core"], path);
      else if (protocolJava.has(name)) add(["java", "core", "browser"], path);
      else add(suites, path);
    } else if (/^workbench\/src\/(scenario|execution)\/.*\.ts$/.test(path)) {
      add(["static", "core"], path);
    } else if (/^workbench\/src\/demos\/orders\/.*\.ts$/.test(path)) {
      add(["static", "core"], path);
    } else if (/^workbench\/src\/service\//.test(path)) {
      add(["static", "core", "demo", "browser", "native"], path);
    } else if (
      /^workbench\/(src\/(browser|control|demos\/vehicle)|browser)\//.test(path)
    ) {
      add(["static", "core", "demo", "browser", "native", "engines"], path);
    } else if (
      /^demos\/vehicle-tracker\/(src|pages)\//.test(path) ||
      /^workbench\/scenarios\//.test(path)
    ) {
      add(["static", "core", "demo", "browser", "engines"], path);
    } else if (/^workbench\/test\/demo-unit\/[^/]+\.test\.ts$/.test(path)) {
      add(["static", "demo"], path);
    } else if (/^workbench\/test\/browser\/[^/]+\.test\.ts$/.test(path)) {
      add(["static", "browser"], path);
    } else if (/^workbench\/test\/platform\/[^/]+\.test\.ts$/.test(path)) {
      add(["static", "engines"], path);
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
