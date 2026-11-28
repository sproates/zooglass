import type { NodeName } from "./types.js";

export interface ProxyHealth {
  node: NodeName;
  status: string;
  checkStatus: string;
  checkCode: string;
}

// HAProxy's statistics CSV includes descriptions which may contain quoted commas.
function columns(line: string): string[] {
  const values: string[] = [];
  let value = "",
    quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index++;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else value += character;
  }
  if (quoted) throw new Error("Incomplete proxy statistics CSV");
  values.push(value);
  return values;
}

export function proxyHealth(csv: string): ProxyHealth[] {
  const lines = csv.trim().split(/\r?\n/);
  if (!lines[0]?.startsWith("# "))
    throw new Error("Missing proxy statistics header");
  const header = columns(lines[0].slice(2));
  const fields = ["pxname", "svname", "status", "check_status", "check_code"];
  if (fields.some((field) => !header.includes(field)))
    throw new Error("Incomplete proxy statistics fields");
  const result: ProxyHealth[] = [];
  for (const line of lines.slice(1).filter(Boolean)) {
    const row = columns(line);
    if (row.length !== header.length)
      throw new Error("Incomplete proxy statistics row");
    const at = (name: string) => row[header.indexOf(name)];
    if (at("pxname") !== "zoo" || !["node-a", "node-b"].includes(at("svname")))
      continue;
    result.push({
      node: at("svname") as NodeName,
      status: at("status"),
      checkStatus: at("check_status"),
      checkCode: at("check_code"),
    });
  }
  if (
    result.length !== 2 ||
    new Set(result.map((row) => row.node)).size !== 2
  ) {
    throw new Error(
      "Expected health statistics for exactly two fixture backends",
    );
  }
  return result;
}

/** DOWN without a completed matching probe result is only startup state, not evidence. */
export function probeRefusalObserved(
  health: readonly ProxyHealth[],
  kind: "credential" | "certificate-hostname",
): boolean {
  return (
    health.length === 2 &&
    new Set(health.map((row) => row.node)).size === 2 &&
    health.every(
      (row) =>
        row.status === "DOWN" &&
        (kind === "credential"
          ? row.checkStatus === "L7STS" && row.checkCode === "401"
          : row.checkStatus === "L6RSP"),
    )
  );
}
