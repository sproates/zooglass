import { basicConfiguration } from "./configuration.js";
import { semanticConfiguration } from "./semantic-cases.js";
import type { AccessMode } from "../ha-fixture/types.js";
export interface FaultCase {
  id: number;
  name: string;
  mode: AccessMode;
  route: "direct" | "proxy";
  configuration: unknown;
  timeoutMillis: number;
  barriers: readonly string[];
  expectations: readonly string[];
  coverage: readonly string[];
}
const entry = (
  id: number,
  name: string,
  barriers: string[],
  expectations: string[],
  coverage: string[] = [],
): FaultCase => ({
  id,
  name,
  mode: [10, 11, 12, 14].includes(id) ? "applicationPolicy" : "openDemo",
  route: id >= 13 ? "proxy" : "direct",
  configuration:
    id >= 9 && id <= 12 ? semanticConfiguration : basicConfiguration(id === 13),
  timeoutMillis: 180000,
  barriers,
  expectations,
  coverage: [
    ...coverage,
    id === 13 ? "coalesceLatestState" : "disconnectOnOverflow",
    id >= 13 ? "proxy" : "direct",
  ],
});
/** Authored, finite acceptance cases. A single run is a harness check, not the 28-run qualification. */
export const faultCases: readonly FaultCase[] = [
  entry(
    1,
    "simultaneous-acquisition",
    [
      "both JVMs launch after both sidecars are ready",
      "checked readiness from both listeners",
    ],
    ["exactly one active owner", "empty view and revision0"],
    ["envelopeEntity", "immediate"],
  ),
  entry(
    2,
    "orderly-handover",
    [
      "committed receipt1",
      "SIGTERM former owner",
      "higher-generation successor",
    ],
    [
      "same incarnation",
      "retry duplicate at original version1 and targets",
      "snapshot1 retained",
    ],
  ),
  entry(
    3,
    "termination-before-commit",
    [
      "source hello before publication",
      "write entry barrier before authority check",
      "revision0 before SIGKILL",
    ],
    [
      "no receipt for killed transaction",
      "same bytes commit once at revision1",
    ],
  ),
  entry(
    4,
    "commit-with-lost-receipt",
    [
      "actual receipt retained outside producer callback",
      "database revision1",
      "SIGKILL owner",
    ],
    ["producer retries original bytes", "duplicate original outcome1"],
  ),
  entry(
    5,
    "acknowledged-work-survives",
    ["live update1 and committed receipt", "SIGKILL owner"],
    [
      "viewer clears old connection",
      "higher-generation fresh baseline1",
      "same committed snapshot",
    ],
  ),
  entry(
    6,
    "reachable-former-owner",
    [
      "partition only former owner's database gate",
      "successor checks higher generation",
    ],
    [
      "former HTTP503 and unresolved source work",
      "no stale revision increment",
      "successor advances revision2",
    ],
  ),
  entry(
    7,
    "write-and-output-boundaries",
    [
      "write entry barrier before authority check then SIGSTOP",
      "test agent holds captured revision7 before handoff",
      "commit8 while writer waits",
      "actual after-permit pause across takeover",
    ],
    [
      "stale write cannot commit",
      "FIFO content7 authority8 then content8",
      "unchanged view version1 at capture8",
      "new output refused on former owner",
    ],
    ["latestBySequence", "arrival"],
  ),
  entry(
    8,
    "paused-lock-holder",
    [
      "write authority check completed and service backend PID observed",
      "owner paused past lease",
      "candidate blocked by that PID",
    ],
    [
      "server timeout releases holder",
      "higher generation activates",
      "resumed former owner cannot serve",
    ],
  ),
  entry(
    9,
    "state-strategy-recovery",
    [
      "hidden candidates and pending required view",
      "owner termination",
      "successor recovery",
    ],
    [
      "primary priority survives",
      "required view releases at revision3",
      "history [9,19] and arrival9 at revision4",
      "history limit rejection unchanged",
    ],
    [
      "sourcePriority",
      "requireContributions",
      "historyBySequence",
      "arrival",
      "latestBySequence",
    ],
  ),
  entry(
    10,
    "retention-and-binding-refusals",
    [
      "retained stream advanced beyond floor",
      "stopped candidate restarts with incompatible bindings",
    ],
    [
      "identity conflict and outside-retention refusal",
      "unsupported controls refused",
      "configuration tenant and schema mismatch never installs partial state",
    ],
  ),
  entry(
    11,
    "protected-reconnect",
    [
      "policy refusal during takeover",
      "policy unavailable",
      "fresh policy admission",
      "actual grant deadline",
    ],
    [
      "no migrated grant or leaked snapshot",
      "fresh baseline after admission",
      "expired subscription closes",
    ],
  ),
  entry(
    12,
    "backend-recovery-and-cancellation",
    [
      "PostgreSQL stopped then restarted",
      "candidate restart",
      "fixture AbortSignal",
    ],
    [
      "no cache-only output",
      "exact committed data and retry preserved",
      "owned resources removed",
    ],
  ),
  entry(
    13,
    "stable-origin-open",
    [
      "actual proxy-routed HTTP and WebSocket",
      "owner termination",
      "retained HTTP body and old WebSocket callback",
    ],
    [
      "same origin reaches different instance and higher generation",
      "old callbacks discarded",
      "retained retry and continued update2",
    ],
  ),
  entry(
    14,
    "stable-origin-protected",
    [
      "protected proxy owner termination",
      "frozen old proxy health across takeover",
      "denied grant renewal",
      "bad probe credentials and hostname",
      "backend outage",
    ],
    [
      "fresh policy admission and baseline",
      "old callbacks discarded",
      "stale routing cannot authorise output",
      "no-ready connection fails boundedly",
      "certificate verification enforced",
      "committed snapshot3 recovers",
    ],
  ),
];
export function validateManifest(
  cases: readonly FaultCase[] = faultCases,
): void {
  if (cases.length !== 14 || cases.some((item, index) => item.id !== index + 1))
    throw new Error("Expected exactly fourteen ordered fixed fault cases");
  const names = new Set<string>(),
    coverage = new Set(cases.flatMap((item) => item.coverage));
  for (const item of cases) {
    if (
      names.has(item.name) ||
      !item.name ||
      !item.barriers.length ||
      !item.expectations.length ||
      item.timeoutMillis !== 180000
    )
      throw new Error("Invalid fixed fault manifest");
    names.add(item.name);
    if (
      item.mode !==
        ([10, 11, 12, 14].includes(item.id)
          ? "applicationPolicy"
          : "openDemo") ||
      item.route !== (item.id >= 13 ? "proxy" : "direct")
    )
      throw new Error("Access/routing coverage changed");
  }
  for (const required of [
    "arrival",
    "latestBySequence",
    "historyBySequence",
    "envelopeEntity",
    "sourcePriority",
    "requireContributions",
    "immediate",
    "disconnectOnOverflow",
    "coalesceLatestState",
    "direct",
    "proxy",
  ]) {
    if (!coverage.has(required))
      throw new Error(`Missing admitted capability: ${required}`);
  }
}
