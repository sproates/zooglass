import assert from "node:assert/strict";
import test from "node:test";
import {
  runtimeConfiguration,
  runtimeView,
} from "../src/service/runtime-configuration.js";

test("scenario declarations compile to the publication runtime without mutating their inputs", () => {
  const view = {
    id: "scores",
    fields: {
      score: [
        { sourceId: "match", type: "scored" },
        { sourceId: "match", type: "corrected" },
      ],
    },
    ordering: {
      score: {
        mode: "latestBySequence" as const,
        sequenceField: "publicationSequence",
      },
    },
  };
  const before = structuredClone(view);
  const configuration = runtimeConfiguration(
    [view],
    [{ id: "unused", name: "Unused source" }],
  );
  assert.deepEqual(configuration.sources, [
    { id: "unused", epoch: "run" },
    { id: "match", epoch: "run" },
  ]);
  assert.deepEqual(configuration.views, [
    {
      id: "scores",
      fields: {
        score: {
          inputs: [
            { sourceId: "match", type: "scored" },
            { sourceId: "match", type: "corrected" },
          ],
          mode: "latestBySequence",
        },
      },
    },
  ]);
  assert.equal(configuration.contractVersion, 2);
  assert.equal(configuration.storage, "memory");
  assert.deepEqual(view, before);
});

test("scenario translation refuses ambiguous source competition and payload ordering", () => {
  const fields = { score: [{ sourceId: "match", type: "scored" }] };
  assert.throws(
    () =>
      runtimeView({
        id: "scores",
        fields: {
          score: [...fields.score, { sourceId: "other", type: "scored" }],
        },
      }),
    /explicit runtime policy/,
  );
  assert.throws(
    () =>
      runtimeView({
        id: "scores",
        fields,
        ordering: {
          score: {
            mode: "latestBySequence",
            sequenceField: "payload.sequence",
          },
        },
      }),
    /must order by publicationSequence/,
  );
  assert.deepEqual(runtimeView({ id: "scores", fields }), {
    id: "scores",
    fields: { score: { sourceId: "match", type: "scored", mode: "arrival" } },
  });
});

test("fields named like inherited properties default to arrival ordering", () => {
  const inputs = [{ sourceId: "feed", type: "sample" }];
  const view = runtimeView({
    id: "stats",
    fields: { constructor: inputs, toString: inputs, latest: inputs },
    ordering: {
      latest: {
        mode: "latestBySequence",
        sequenceField: "publicationSequence",
      },
    },
  });
  assert.equal(view.fields["constructor"].mode, "arrival");
  assert.equal(view.fields["toString"].mode, "arrival");
});
