import { encodeJson, type Json } from "./json.js";
import { object, runtimeCounter, text } from "./validation.js";

export type DeliveredReceipt = {
  eventId: string;
  actor: string;
  atMs: number;
  envelope: Json;
};

export function publicationIdentity(value: Json) {
  const body = object(value, "publication");
  for (const key of ["sourceId", "epoch", "sourceEntityId"])
    text(body[key], `publication.${key}`);
  runtimeCounter(body.publicationSequence, "publication.publicationSequence");
  return {
    stream: {
      sourceId: body.sourceId,
      epoch: body.epoch,
      sourceEntityId: body.sourceEntityId,
    },
    publicationSequence: body.publicationSequence,
  };
}

/** Read only this actor's timestamp; full-envelope observations remain cumulative. */
export function acceptedReceipt(
  receipts: readonly DeliveredReceipt[],
  identity: Json,
  used: ReadonlySet<string>,
) {
  if (receipts.length !== 1 || used.has(receipts[0].eventId)) return undefined;
  const receipt = object(receipts[0].envelope, "receipt");
  if (!["applied", "committed", "duplicate"].includes(String(receipt.status)))
    return undefined;
  return encodeJson({
    stream: receipt.stream,
    publicationSequence: receipt.publicationSequence,
  }) === encodeJson(identity)
    ? receipts[0].eventId
    : undefined;
}
