import { Decimal, type Json } from "./json.js";
import { choice, invalid, list, object, text } from "./validation.js";

// Runtime counters are Java longs, not agenda coordinates or JavaScript numbers.
export function counter(
  value: Json | undefined,
  path: string,
  nullable = false,
) {
  if (nullable && value === null) return;
  if (
    !(value instanceof Decimal) ||
    !/^\d+$/.test(value.text) ||
    BigInt(value.text) > 9223372036854775807n
  )
    invalid(path, "expected nonnegative signed-64-bit integer");
}
function nullableText(value: Json | undefined, path: string) {
  if (value !== null) text(value, path);
}
function strings(value: Json | undefined, path: string) {
  list(value, path).forEach((item, i) => text(item, `${path}[${i}]`));
}
function boolean(value: Json | undefined, path: string) {
  if (typeof value !== "boolean") invalid(path, "expected boolean");
}
function stream(value: Json | undefined, path: string) {
  const data = object(value, path, ["sourceId", "epoch", "sourceEntityId"]);
  for (const name of Object.keys(data)) text(data[name], `${path}.${name}`);
}

export function receiptEnvelope(value: Json | undefined, path: string) {
  const data = object(value, path, [
    "status",
    "reason",
    "stream",
    "publicationSequence",
    "version",
    "changedViews",
    "targets",
  ]);
  const status = choice(data.status, `${path}.status`, [
    "applied",
    "duplicate",
    "rejected",
    "failed",
  ]);
  nullableText(data.reason, `${path}.reason`);
  if (data.stream !== null) stream(data.stream, `${path}.stream`);
  counter(data.publicationSequence, `${path}.publicationSequence`, true);
  counter(data.version, `${path}.version`, true);
  if (status === "applied" || status === "duplicate") {
    stream(data.stream, `${path}.stream`);
    counter(data.publicationSequence, `${path}.publicationSequence`);
    counter(data.version, `${path}.version`);
  }
  strings(data.changedViews, `${path}.changedViews`);
  if (data.targets === null) return;
  list(data.targets, `${path}.targets`).forEach((item, i) => {
    const targetPath = `${path}.targets[${i}]`;
    const target = object(item, targetPath, [
      "viewId",
      "entityId",
      "status",
      "reason",
      "changedFields",
      "fields",
    ]);
    text(target.viewId, `${targetPath}.viewId`);
    nullableText(target.entityId, `${targetPath}.entityId`);
    text(target.status, `${targetPath}.status`);
    nullableText(target.reason, `${targetPath}.reason`);
    strings(target.changedFields, `${targetPath}.changedFields`);
    if (target.fields !== null)
      list(target.fields, `${targetPath}.fields`).forEach((item, j) => {
        const fieldPath = `${targetPath}.fields[${j}]`;
        const field = object(item, fieldPath, [
          "field",
          "status",
          "reason",
          "changed",
        ]);
        text(field.field, `${fieldPath}.field`);
        text(field.status, `${fieldPath}.status`);
        nullableText(field.reason, `${fieldPath}.reason`);
        boolean(field.changed, `${fieldPath}.changed`);
      });
  });
}

function viewStatus(value: Json | undefined, path: string) {
  const data = object(value, path, [
    "publication",
    "missingFields",
    "missingRequiredFields",
    "fields",
    "inputs",
  ]);
  choice(data.publication, `${path}.publication`, [
    "ready",
    "partial",
    "waiting",
  ]);
  strings(data.missingFields, `${path}.missingFields`);
  strings(data.missingRequiredFields, `${path}.missingRequiredFields`);
  for (const [name, item] of Object.entries(
    object(data.fields, `${path}.fields`),
  )) {
    const fieldPath = `${path}.fields.${name}`;
    const field = object(item, fieldPath);
    object(field, fieldPath, [
      "freshness",
      "receivedAtMillis",
      "inputs",
      ...(Object.hasOwn(field, "facts") ? ["facts"] : []),
    ]);
    text(field.freshness, `${fieldPath}.freshness`);
    counter(field.receivedAtMillis, `${fieldPath}.receivedAtMillis`, true);
    strings(field.inputs, `${fieldPath}.inputs`);
    if (Object.hasOwn(field, "facts")) {
      const facts = object(field.facts, `${fieldPath}.facts`, [
        "minimumBirthSequence",
        "retainedCount",
        "activeCount",
      ]);
      for (const key of Object.keys(facts))
        counter(facts[key], `${fieldPath}.facts.${key}`);
    }
  }
  for (const [name, item] of Object.entries(
    object(data.inputs, `${path}.inputs`),
  )) {
    const inputPath = `${path}.inputs.${name}`;
    const input = object(item, inputPath, [
      "state",
      "mode",
      "epoch",
      "sourceEntityId",
      "startSequence",
      "observedThrough",
      "watermarkThrough",
      "completeThrough",
      "completeness",
      "admissionFloor",
      "sourceContractViolated",
      "missingRanges",
    ]);
    for (const key of ["state", "mode", "epoch", "completeness"])
      text(input[key], `${inputPath}.${key}`);
    nullableText(input.sourceEntityId, `${inputPath}.sourceEntityId`);
    for (const key of [
      "startSequence",
      "observedThrough",
      "watermarkThrough",
      "completeThrough",
      "admissionFloor",
    ])
      counter(input[key], `${inputPath}.${key}`, true);
    boolean(
      input.sourceContractViolated,
      `${inputPath}.sourceContractViolated`,
    );
    list(input.missingRanges, `${inputPath}.missingRanges`).forEach(
      (item, i) => {
        const rangePath = `${inputPath}.missingRanges[${i}]`;
        const range = object(item, rangePath, ["from", "through", "status"]);
        text(range.status, `${rangePath}.status`);
        counter(range.from, `${rangePath}.from`);
        counter(range.through, `${rangePath}.through`);
        if (
          BigInt((range.from as Decimal).text) >
          BigInt((range.through as Decimal).text)
        )
          invalid(rangePath, "range is reversed");
      },
    );
  }
}

export function snapshotEnvelope(
  value: Json | undefined,
  path: string,
  publicFrame = false,
) {
  const data = object(value, path, [
    "data",
    "entityId",
    "provenance",
    "status",
    "version",
    "viewId",
    ...(publicFrame ? ["publicationSequences", "type"] : []),
  ]);
  object(data.data, `${path}.data`); // Domain payloads remain lossless and unconstrained.
  text(data.entityId, `${path}.entityId`);
  text(data.viewId, `${path}.viewId`);
  counter(data.version, `${path}.version`);
  for (const [name, item] of Object.entries(
    object(data.provenance, `${path}.provenance`),
  ))
    stream(item, `${path}.provenance.${name}`);
  viewStatus(data.status, `${path}.status`);
  if (publicFrame) {
    choice(data.type, `${path}.type`, ["view-update"]);
    for (const [name, sequences] of Object.entries(
      object(data.publicationSequences, `${path}.publicationSequences`),
    )) {
      list(sequences, `${path}.publicationSequences.${name}`).forEach(
        (seq, i) => counter(seq, `${path}.publicationSequences.${name}[${i}]`),
      );
    }
  }
}
export function clientEnvelope(value: Json | undefined, path: string) {
  const data = object(value, path);
  const type = choice(data.type, `${path}.type`, [
    "view-update",
    "subscribed",
    "unsubscribed",
    "error",
  ]);
  if (type === "view-update") return snapshotEnvelope(data, path, true);
  if (type === "error") {
    object(data, path, ["type", "message"]);
    text(data.message, `${path}.message`);
    return;
  }
  object(data, path, [
    "type",
    "viewId",
    "entityId",
    ...(type === "subscribed" ? ["recovery"] : []),
  ]);
  text(data.viewId, `${path}.viewId`);
  text(data.entityId, `${path}.entityId`);
  if (type === "subscribed")
    choice(data.recovery, `${path}.recovery`, ["freshSnapshot"]);
}
export function observationList(
  value: Json | undefined,
  path: string,
  kind: string,
) {
  list(value, path).forEach((item, i) =>
    (kind === "client-frames" ? clientEnvelope : receiptEnvelope)(
      item,
      `${path}[${i}]`,
    ),
  );
}
