// Branch conventions affect development PRs, never PRs into main.
export function validationMode(event, eventName) {
  if (eventName === "workflow_dispatch") {
    return event.inputs?.mode === "selected" ? "selected" : "full";
  }

  const pr = event.pull_request;
  if (pr?.base.ref === "main") return "selected";

  const segments = [pr?.head.ref, pr?.base.ref]
    .filter(Boolean)
    .flatMap((branch) => branch.toLowerCase().split("/"));
  if (segments.includes("no-ci")) return "none";
  if (segments.includes("core-ci")) return "core";
  return "selected";
}
