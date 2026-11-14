import { encodeJson, type Json } from "./json.js";
import {
  choice,
  integer,
  invalid,
  list,
  object,
  runtimeCounter,
  text,
} from "./validation.js";

/** Requests stay opaque: production ProgressIngress owns even malformed controls. */
export function progressControl(value: Json | undefined, path: string) {
  return object(value, path);
}

/** Complete SQLite watermark acknowledgements, retaining exact Java-long versions. */
export function watermarkEnvelope(value: Json | undefined, path: string) {
  const data = object(value, path, [
    "kind",
    "status",
    "reason",
    "stream",
    "throughSequence",
    "version",
    "changedViews",
  ]);
  choice(data.kind, `${path}.kind`, ["watermark"]);
  const status = choice(data.status, `${path}.status`, [
    "committed",
    "duplicate",
    "rejected",
  ]);
  choice(
    data.reason,
    `${path}.reason`,
    status === "committed"
      ? ["sqlite"]
      : status === "duplicate"
        ? ["alreadyCommitted"]
        : [
            "invalidProgress",
            "unknownSource",
            "unknownEpoch",
            "streamLimit",
            "progressUntracked",
            "backwardsWatermark",
            "progressLimit",
          ],
  );
  const changed = list(data.changedViews, `${path}.changedViews`);
  if (new Set(changed).size !== changed.length)
    invalid(path, "changed views must be unique");
  changed.forEach((view, i) => text(view, `${path}.changedViews[${i}]`));
  if (data.reason === "invalidProgress") {
    if (
      status !== "rejected" ||
      data.stream !== null ||
      data.throughSequence !== null ||
      data.version !== null
    )
      invalid(
        path,
        "invalidProgress requires a rejected acknowledgement with null identities",
      );
  } else {
    const stream = object(data.stream, `${path}.stream`, [
      "sourceId",
      "epoch",
      "sourceEntityId",
    ]);
    for (const key of Object.keys(stream))
      text(stream[key], `${path}.stream.${key}`);
    integer(
      data.throughSequence,
      `${path}.throughSequence`,
      Number.MAX_SAFE_INTEGER,
      1,
    );
    runtimeCounter(data.version, `${path}.version`);
    if (status !== "rejected" && encodeJson(data.version) === "0")
      invalid(
        path,
        "committed or duplicate watermark version must be positive",
      );
  }
  if (status !== "committed" && changed.length)
    invalid(path, "only a committed watermark can change views");
  if (status === "committed" && data.reason !== "sqlite")
    invalid(path, "committed watermark requires sqlite reason");
  if (status === "duplicate" && data.reason !== "alreadyCommitted")
    invalid(path, "duplicate watermark requires alreadyCommitted reason");
  return data;
}
