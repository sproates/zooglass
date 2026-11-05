import assert from "node:assert/strict";
import test from "node:test";
import { parseView } from "../src/scenario/scenario-view.js";

const valid = {
  id: "latest",
  fields: { position: [{ sourceId: "feed", type: "position" }] },
};
const sourceIds = new Set(["feed"]);
const invalid: { input: unknown; message: string }[] = [
  { input: null, message: "Expected view to be an object." },
  {
    input: { ...valid, fields: {} },
    message: "Expected view.fields to be a non-empty object.",
  },
  {
    input: { ...valid, fields: { position: [] } },
    message: "Expected view.fields.position to be a non-empty array.",
  },
  {
    input: { ...valid, fields: { position: [null] } },
    message: "Expected view.fields.position[0] to be an object.",
  },
  {
    input: {
      ...valid,
      fields: { position: [{ sourceId: "feed", type: " " }] },
    },
    message: "Expected view.fields.position[0].type to be a non-empty string.",
  },
  {
    input: { ...valid, ordering: [] },
    message: "Expected view.ordering to be an object.",
  },
  {
    input: { ...valid, ordering: { missing: {} } },
    message: 'Ordering is configured for unknown field "missing" in view.',
  },
  {
    input: { ...valid, ordering: { position: null } },
    message: "Expected view.ordering.position to be an object.",
  },
  {
    input: { ...valid, ordering: { position: { mode: "arrival" } } },
    message:
      'Expected view.ordering.position.mode to be "latestBySequence" or "historyBySequence".',
  },
  {
    input: {
      ...valid,
      ordering: { position: { mode: "latestBySequence", sequenceField: "" } },
    },
    message:
      "Expected view.ordering.position.sequenceField to be a non-empty string.",
  },
];

for (const { input, message } of invalid) {
  test(message, () => {
    assert.throws(() => parseView(input, "view", sourceIds), { message });
  });
}

test("view parsing preserves both supported ordering policies and detaches matcher arrays", () => {
  for (const mode of ["latestBySequence", "historyBySequence"]) {
    const input = {
      ...valid,
      ordering: { position: { mode, sequenceField: "sequence" } },
    };
    const before = structuredClone(input);
    const parsed = parseView(input, "view", sourceIds);
    assert.deepEqual(parsed, before);
    parsed.fields.position.push({ sourceId: "feed", type: "other" });
    assert.deepEqual(input, before);
  }
});
