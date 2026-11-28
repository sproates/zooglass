/** Small authored witness; the second view proves unchanged content at a newer global capture. */
export function basicConfiguration(coalesce = false) {
  return {
    contractVersion: 2,
    storage: "postgresql",
    maxStreams: 6,
    identityWindow: 16,
    maxHistoryEntries: 4,
    sources: [{ id: "feed", epoch: "run" }],
    views: [
      {
        id: "match",
        fields: {
          score: {
            sourceId: "feed",
            type: "updated",
            mode: "latestBySequence",
          },
        },
      },
      {
        id: "static",
        fields: {
          marker: { sourceId: "feed", type: "marker", mode: "arrival" },
        },
      },
    ],
    delivery: {
      slowClient: coalesce ? "coalesceLatestState" : "disconnectOnOverflow",
      maxQueuedMessages: 32,
      maxQueuedBytes: 262144,
    },
  };
}
