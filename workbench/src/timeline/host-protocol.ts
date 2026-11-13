/** Private pipe metadata uses safe integers; domain payloads remain exact wire strings. */
export type SessionEffect =
  | { kind: "receipt"; session: string; wire: string }
  | { kind: "handoff"; session: string; wire: string }
  | { kind: "frame"; session: string; wire: string }
  | { kind: "close"; session: string; code: number };
export type Effect =
  | {
      kind: "schedule";
      task: number;
      at: number;
      phase: 0 | 1 | 2;
      taskKind: string;
    }
  | { kind: "cancel"; task: number }
  | { kind: "state"; wire: string }
  | SessionEffect;
export type TimingDiagnostics = {
  pauseMillis: number;
  pauses: {
    site: string;
    requestedMillis: number;
    elapsedNanos: number;
    virtualMs: number;
  }[];
};
export type Response = {
  diagnostics?: TimingDiagnostics;
  turnId: number;
  runtimeGeneration: number;
  timeMs: number;
  effects: Effect[];
  pendingTasks: number;
  heldFrames: number;
  configuration?: {
    contractVersion: number;
    storage: string;
    documentProfile: string;
  };
};
export type Handshake = {
  protocol: number;
  fixture: string;
  artifact: string;
  frameCap: number;
  storage: string[];
  protectedAccess: boolean;
  environment?: Record<string, string>;
} & (
  | { configurationAdmission: number; documentFormats: string[] }
  | { configurationAdmission?: undefined; documentFormats?: undefined }
);

function invalid(path: string): never {
  throw new Error(`Invalid host protocol: ${path}`);
}
function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(path);
  return value as Record<string, unknown>;
}
function integer(
  value: unknown,
  path: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    invalid(path);
}
function string(value: unknown, path: string) {
  if (typeof value !== "string" || !value.length) invalid(path);
}
function strings(value: unknown, path: string) {
  if (!Array.isArray(value)) invalid(path);
  value.forEach((item, index) => string(item, `${path}[${index}]`));
}

export function decodeHandshake(value: unknown): Handshake {
  const data = record(value, "handshake");
  integer(data.protocol, "handshake.protocol", 1);
  string(data.fixture, "handshake.fixture");
  string(data.artifact, "handshake.artifact");
  integer(data.frameCap, "handshake.frameCap", 1);
  strings(data.storage, "handshake.storage");
  if (typeof data.protectedAccess !== "boolean")
    invalid("handshake.protectedAccess");
  if (data.configurationAdmission !== undefined) {
    integer(data.configurationAdmission, "handshake.configurationAdmission", 1);
    strings(data.documentFormats, "handshake.documentFormats");
  } else if (data.documentFormats !== undefined) {
    invalid("handshake.documentFormats requires configurationAdmission");
  }
  if (data.environment !== undefined) {
    const environment = record(data.environment, "handshake.environment");
    for (const [key, item] of Object.entries(environment))
      if (typeof item !== "string") invalid(`handshake.environment.${key}`);
  }
  return value as Handshake;
}

function effect(value: unknown, index: number) {
  const path = `response.effects[${index}]`;
  const data = record(value, path);
  switch (data.kind) {
    case "schedule":
      integer(data.task, `${path}.task`, 1);
      integer(data.at, `${path}.at`);
      integer(data.phase, `${path}.phase`, 0, 2);
      string(data.taskKind, `${path}.taskKind`);
      return;
    case "cancel":
      integer(data.task, `${path}.task`, 1);
      return;
    case "state":
      string(data.wire, `${path}.wire`);
      return;
    case "receipt":
    case "handoff":
    case "frame":
      string(data.session, `${path}.session`);
      string(data.wire, `${path}.wire`);
      return;
    case "close":
      string(data.session, `${path}.session`);
      integer(data.code, `${path}.code`, 0, 65535);
      return;
    default:
      invalid(`${path}.kind`);
  }
}

export function decodeResponse(value: unknown): Response {
  const data = record(value, "response");
  integer(data.turnId, "response.turnId");
  integer(data.runtimeGeneration, "response.runtimeGeneration", 1);
  integer(data.timeMs, "response.timeMs");
  integer(data.pendingTasks, "response.pendingTasks");
  integer(data.heldFrames, "response.heldFrames");
  if (!Array.isArray(data.effects)) invalid("response.effects");
  data.effects.forEach(effect);
  if (data.configuration !== undefined) {
    const config = record(data.configuration, "response.configuration");
    integer(
      config.contractVersion,
      "response.configuration.contractVersion",
      1,
    );
    string(config.storage, "response.configuration.storage");
    string(config.documentProfile, "response.configuration.documentProfile");
  }
  if (data.diagnostics !== undefined) {
    const diagnostics = record(data.diagnostics, "response.diagnostics");
    integer(
      diagnostics.pauseMillis,
      "response.diagnostics.pauseMillis",
      0,
      250,
    );
    if (!Array.isArray(diagnostics.pauses))
      invalid("response.diagnostics.pauses");
    diagnostics.pauses.forEach((value, index) => {
      const path = `response.diagnostics.pauses[${index}]`;
      const pause = record(value, path);
      string(pause.site, `${path}.site`);
      integer(pause.requestedMillis, `${path}.requestedMillis`, 0, 250);
      integer(pause.elapsedNanos, `${path}.elapsedNanos`);
      integer(pause.virtualMs, `${path}.virtualMs`);
    });
  }
  return value as Response;
}
