/** Demo diagnostics only. These observations never drive the vehicle views. */
const limit = 100;
let count = 0;

function append(category: string, detail: string) {
  const list = document.getElementById("activity")!;
  const item = document.createElement("li");
  const label = document.createElement("strong");

  label.textContent = `${category}: `;
  item.append(label, document.createTextNode(detail));
  list.append(item);
  count++;

  while (list.children.length > limit) list.firstElementChild!.remove();

  document.getElementById("activity-count")!.textContent =
    `Showing ${list.children.length} of ${count} observed entries (latest ${limit} retained).`;
}

export function recordSourceSend(message: Record<string, unknown>) {
  const kind =
    message.eventType === "vehicle.operation.updated"
      ? "operation"
      : "position";
  const position =
    typeof message.sequence === "number"
      ? `${kind} ${message.sequence}`
      : "event";

  append(
    "Source sent",
    `${message.sourceName}: ${position}${message.entityId ? ` for ${message.entityId}` : ""} at scenario time ${message.simulationTime} ms. Processing is not confirmed by this send.`,
  );
}

export function recordObservation(message: Record<string, unknown>) {
  if (message.type !== "observation") return;

  if (
    [
      "recovery-armed",
      "interrupted",
      "retry-attempt",
      "retry-failed",
      "recovered",
    ].includes(String(message.event))
  ) {
    append(
      "Recovery",
      `${message.event}${message.attempt ? ` ${message.attempt}` : ""}${message.reason ? `: ${message.reason}` : ""}.`,
    );
    return;
  }

  const connection = `connection ${message.connectionGeneration}`;

  if (message.event === "opened" || message.event === "closed") {
    append("Connection", `${message.event} (${connection}).`);
    return;
  }

  if (message.event === "subscribed" || message.event === "unsubscribed") {
    append(
      "Subscription",
      `${message.viewId}${message.entityId ? ` (${message.entityId})` : ""}: ${message.event} (${connection}).`,
    );
    return;
  }

  if (message.event !== "view-update") return;

  const data = message.data as Record<string, unknown>;
  const position = data.position as { sequence?: number } | undefined;
  const history = data.positions;
  const detail =
    message.viewId === "live-map" || message.viewId === "fleet-state"
      ? `position ${position?.sequence ?? "unavailable"}`
      : Array.isArray(history)
        ? `${history.length} received position${history.length === 1 ? "" : "s"}`
        : "snapshot";

  append(
    "View received",
    `${message.viewId}${message.entityId ? ` (${message.entityId})` : ""}: ${detail} (${connection}).`,
  );
}

export function recordFault(action: string) {
  append(
    "Fault gate",
    action === "break"
      ? "Data route interrupted; upgrades refused."
      : "Data route restored; client recovery remains automatic.",
  );
}

export function resetActivity() {
  count = 0;
  document.getElementById("activity")!.replaceChildren();
  document.getElementById("activity-count")!.textContent =
    "No activity in this run.";
}
