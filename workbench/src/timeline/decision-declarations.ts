import type { TimelineDocument } from "./contract.js";
import type { RecordedDecision } from "./trace-decisions.js";
import { encodeJson, parseJson } from "./json.js";
import { invalid, list, object } from "./validation.js";

/** Bind recorded metadata to authored publications and configured fields, without rerunning strategies. */
export function checkDecisionDeclarations(
  scenario: TimelineDocument,
  wire: string,
  entries: RecordedDecision[],
) {
  const publications = list(scenario.document.publications, "publications").map(
    (value) => object(value, "publication"),
  );
  const views = list(
    object(parseJson(wire), "configuration").views,
    "views",
  ).map((value) => object(value, "view"));
  for (const { event, attempt, receipt } of entries) {
    const publication = publications.find(
      (value) => value.id === attempt.data.publication,
    );
    if (!publication) invalid(event.id, "unknown publication attempt");
    const body = object(publication.body, event.id);
    const outcome = object(receipt.data.envelope, receipt.id);
    const envelope = object(event.data.envelope, event.id);
    if (
      envelope.availability === "unavailable" &&
      envelope.reason === "invalidEnvelope"
    )
      continue;
    const identity = {
      sourceId: body.sourceId,
      epoch: body.epoch,
      sourceEntityId: body.sourceEntityId,
    };
    if (
      encodeJson(outcome.stream) !== encodeJson(identity) ||
      encodeJson(outcome.publicationSequence) !==
        encodeJson(body.publicationSequence)
    )
      invalid(event.id, "receipt identity differs from authored publication");
    if (envelope.availability !== "recorded") continue;
    const decision = object(envelope.decision, event.id);
    if (!decision.installed) continue;
    const targets = list(decision.targets, event.id);
    const matching = views
      .map((view) => ({
        view,
        fields: Object.entries(object(view.fields, "fields"))
          .filter(([, value]) => {
            const field = object(value, "field");
            const inputs =
              field.inputs === undefined || field.inputs === null
                ? [field]
                : list(field.inputs, "inputs").map((value) =>
                    object(value, "input"),
                  );
            return inputs.some(
              (input) =>
                input.sourceId === body.sourceId && input.type === body.type,
            );
          })
          .map(([name]) => name)
          .sort(),
      }))
      .filter((value) => value.fields.length);
    if (targets.length !== matching.length)
      invalid(
        event.id,
        "decision targets differ from configured publication bindings",
      );
    const receiptTargets = list(outcome.targets, receipt.id);
    if (targets.length !== receiptTargets.length)
      invalid(event.id, "decision target count differs from receipt");
    targets.forEach((value, index) => {
      const target = object(value, event.id);
      const original = object(receiptTargets[index], receipt.id);
      const view = views.find((view) => view.id === target.viewId);
      if (
        !view ||
        target.viewId !== original.viewId ||
        target.entityId !== original.entityId ||
        target.entityId !== body.sourceEntityId
      )
        invalid(
          event.id,
          "decision target differs from receipt or envelope mapping",
        );
      const expected = matching.find(
        (value) => value.view.id === target.viewId,
      );
      const names = list(target.fields, event.id)
        .map((value) => object(value, event.id).field)
        .sort();
      if (!expected || encodeJson(names) !== encodeJson(expected.fields))
        invalid(
          event.id,
          "decision fields differ from configured publication bindings",
        );
      const configured = object(view.fields, "fields");
      const fields = list(target.fields, event.id);
      const originals = list(original.fields, receipt.id);
      if (fields.length !== originals.length)
        invalid(event.id, "decision field count differs from receipt");
      fields.forEach((value, index) => {
        const field = object(value, event.id);
        const original = object(originals[index], receipt.id);
        const configuration = object(
          configured[String(field.field)],
          "configured field",
        );
        if (
          field.field !== original.field ||
          field.retainedChanged !== original.changed ||
          field.strategy !== configuration.mode
        )
          invalid(
            event.id,
            "decision field differs from receipt or configuration",
          );
      });
    });
  }
}
