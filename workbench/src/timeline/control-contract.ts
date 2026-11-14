import { encodeJson, type Json } from "./json.js";
import { watermarkEnvelope } from "./progress-contract.js";
import {
  choice,
  integer,
  invalid,
  list,
  object,
  runtimeCounter,
  text,
} from "./validation.js";

/** Controls have distinct endpoint identities, but share connection-owned transport. */
export function controlEnvelope(value: Json | undefined, path: string) {
  return object(value, path).kind === "factRetirement"
    ? retirementEnvelope(value, path)
    : watermarkEnvelope(value, path);
}

export function retirementEnvelope(value: Json | undefined, path: string) {
  const data = object(value, path, [
    "kind",
    "status",
    "reason",
    "control",
    "version",
    "floors",
    "changedViews",
  ]);
  choice(data.kind, `${path}.kind`, ["factRetirement"]);
  const status = choice(data.status, `${path}.status`, [
    "committed",
    "unchanged",
    "rejected",
  ]);
  const floors = object(data.floors, `${path}.floors`);
  const changed = list(data.changedViews, `${path}.changedViews`);
  if (status === "rejected") {
    choice(data.reason, `${path}.reason`, [
      "invalidFactRetirement",
      "unknownView",
      "unknownFactField",
      "incompatibleFactFields",
      "unknownEntityMapping",
      "backwardsFactFloor",
      "streamLimit",
      "pendingViewLimit",
      "numericRange",
    ]);
    if (Object.keys(floors).length || changed.length)
      invalid(path, "rejected retirement cannot change floors or views");
    if (data.reason === "invalidFactRetirement") {
      if (data.control !== null || data.version !== null)
        invalid(path, "invalid retirement requires null control and version");
      return data;
    }
  } else if (data.reason !== null)
    invalid(path, "successful retirement requires null reason");
  runtimeCounter(data.version, `${path}.version`);
  const control = object(data.control, `${path}.control`, [
    "viewId",
    "entityId",
    "fields",
    "minimumBirthSequence",
  ]);
  text(control.viewId, `${path}.control.viewId`);
  text(control.entityId, `${path}.control.entityId`);
  integer(
    control.minimumBirthSequence,
    `${path}.control.minimumBirthSequence`,
    Number.MAX_SAFE_INTEGER,
    1,
  );
  const fields = list(control.fields, `${path}.control.fields`).map(
    (field, i) => text(field, `${path}.control.fields[${i}]`),
  );
  if (
    !fields.length ||
    new Set(fields).size !== fields.length ||
    encodeJson(fields) !== encodeJson([...fields].sort())
  )
    invalid(path, "retirement fields must be unique and sorted");
  if (status !== "rejected") {
    if (encodeJson(Object.keys(floors).sort()) !== encodeJson(fields))
      invalid(path, "retirement floors must cover every requested field");
    for (const field of fields) {
      integer(
        floors[field],
        `${path}.floors.${field}`,
        Number.MAX_SAFE_INTEGER,
        1,
      );
      if (
        encodeJson(floors[field]) !== encodeJson(control.minimumBirthSequence)
      )
        invalid(path, "retirement floor differs from request");
    }
    if (
      encodeJson(changed) !==
      encodeJson(status === "committed" ? [control.viewId] : [])
    )
      invalid(path, "retirement changed views disagree with status");
    if (status === "committed" && encodeJson(data.version) === "0")
      invalid(path, "committed retirement version must be positive");
  }
  return data;
}

export function controlRequestMatches(
  request: { [key: string]: Json },
  ack: { [key: string]: Json },
) {
  if (ack.kind === "watermark") {
    if (ack.reason === "invalidProgress") return true;
    const stream = object(ack.stream, "control stream");
    return (
      ["sourceId", "epoch", "sourceEntityId"].every(
        (key) => stream[key] === request[key],
      ) &&
      encodeJson(ack.throughSequence) === encodeJson(request.throughSequence)
    );
  }
  if (ack.reason === "invalidFactRetirement") return true;
  const normalized = {
    ...request,
    fields: [...list(request.fields, "retirement fields")].sort((a, b) =>
      String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
    ),
  };
  return encodeJson(ack.control) === encodeJson(normalized);
}
