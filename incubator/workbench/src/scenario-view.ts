import type {
  ScenarioEventMatcher,
  ScenarioOrdering,
  ScenarioView,
} from "./scenario-model.js";
import { isRecord, requiredString } from "./scenario-validation.js";

function parseOrdering(
  input: unknown,
  label: string,
  fields: Record<string, ScenarioEventMatcher[]>,
): Record<string, ScenarioOrdering> {
  if (!isRecord(input)) {
    throw new Error(`Expected ${label}.ordering to be an object.`);
  }

  const ordering: Record<string, ScenarioOrdering> = {};
  for (const [fieldName, orderingInput] of Object.entries(input)) {
    if (!Object.hasOwn(fields, fieldName)) {
      throw new Error(
        `Ordering is configured for unknown field "${fieldName}" in ${label}.`,
      );
    }
    if (!isRecord(orderingInput)) {
      throw new Error(
        `Expected ${label}.ordering.${fieldName} to be an object.`,
      );
    }
    if (
      orderingInput.mode !== "latestBySequence" &&
      orderingInput.mode !== "historyBySequence"
    ) {
      throw new Error(
        `Expected ${label}.ordering.${fieldName}.mode to be "latestBySequence" or "historyBySequence".`,
      );
    }

    ordering[fieldName] = {
      mode: orderingInput.mode,
      sequenceField: requiredString(
        orderingInput.sequenceField,
        `${label}.ordering.${fieldName}.sequenceField`,
      ),
    };
  }

  return ordering;
}

export function parseView(
  input: unknown,
  label: string,
  sourceIds: Set<string>,
): ScenarioView {
  if (!isRecord(input)) {
    throw new Error(`Expected ${label} to be an object.`);
  }

  if (!isRecord(input.fields) || Object.keys(input.fields).length === 0) {
    throw new Error(`Expected ${label}.fields to be a non-empty object.`);
  }

  const fields: Record<string, ScenarioEventMatcher[]> = {};
  for (const [fieldName, matchersInput] of Object.entries(input.fields)) {
    requiredString(fieldName, `${label} field name`);
    if (!Array.isArray(matchersInput) || matchersInput.length === 0) {
      throw new Error(
        `Expected ${label}.fields.${fieldName} to be a non-empty array.`,
      );
    }

    fields[fieldName] = matchersInput.map((matcher, matcherIndex) => {
      if (!isRecord(matcher)) {
        throw new Error(
          `Expected ${label}.fields.${fieldName}[${matcherIndex}] to be an object.`,
        );
      }

      const sourceId = requiredString(
        matcher.sourceId,
        `${label}.fields.${fieldName}[${matcherIndex}].sourceId`,
      );
      if (!sourceIds.has(sourceId)) {
        throw new Error(
          `View field "${fieldName}" refers to unknown source "${sourceId}".`,
        );
      }

      return {
        sourceId,
        type: requiredString(
          matcher.type,
          `${label}.fields.${fieldName}[${matcherIndex}].type`,
        ),
      };
    });
  }

  const id = requiredString(input.id, `${label}.id`);
  if (input.ordering === undefined) {
    return { id, fields };
  }

  return {
    id,
    fields,
    ordering: parseOrdering(input.ordering, label, fields),
  };
}
