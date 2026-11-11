import type {
  RuntimeConfiguration,
  RuntimeField,
  RuntimeView,
} from "../../service/runtime-contract.js";
import { scenarioEpoch } from "../../service/runtime-configuration.js";
import {
  orderIds,
  sourceEntity,
  sourceIds,
  type OrderSource,
} from "./contracts.js";

function latest(sourceId: string, type: string, timed = false): RuntimeField {
  return {
    sourceId,
    type,
    mode: "latestBySequence",
    late: { mode: "acceptLate" },
    ...(timed
      ? { freshness: { mode: "receiptAge" as const, staleAfterMillis: 15000 } }
      : {}),
  };
}
function view(id: string, tracking: boolean): RuntimeView {
  const sources = sourceIds.filter(
    (source) => !tracking || source !== "payments",
  );
  return {
    id,
    entities: Object.fromEntries(
      sources.map((source) => [
        source,
        source === "orders"
          ? { mode: "envelopeEntity" as const }
          : {
              mode: "lookupEntity" as const,
              keys: Object.fromEntries(
                orderIds.map((id, index) => [sourceEntity(source, index), id]),
              ),
            },
      ]),
    ),
    fields: {
      order: latest("orders", "order.state"),
      ...(!tracking ? { payment: latest("payments", "payment.state") } : {}),
      inventory: latest("inventory", "inventory.state", true),
      delivery: {
        inputs: ["courier-primary", "courier-backup"].map((sourceId) => ({
          sourceId,
          type: "delivery.state",
        })),
        mode: "latestBySequence",
        conflict: {
          mode: "sourcePriority",
          sources: ["courier-primary", "courier-backup"],
        },
        late: { mode: "acceptLate" },
        freshness: { mode: "receiptAge", staleAfterMillis: 15000 },
      },
    },
    publication: tracking
      ? {
          mode: "requireContributions",
          fields: ["order", "inventory"],
          maxPendingEntities: 6,
        }
      : { mode: "publishPartial" },
  };
}

export const trackedSources: OrderSource[] = [
  "orders",
  "payments",
  "inventory",
];
export function orderConfiguration(): RuntimeConfiguration {
  return {
    contractVersion: 2,
    storage: "sqlite",
    maxStreams: 64,
    identityWindow: 128,
    maxHistoryEntries: 64,
    sources: sourceIds.map((id) => ({
      id,
      epoch: scenarioEpoch,
      ...(trackedSources.includes(id)
        ? {
            progress: {
              mode: "contiguousSequence" as const,
              startSequence: 1,
              maxReceivedRanges: 64,
              maxMissingRanges: 64,
            },
          }
        : {}),
    })),
    views: [view("order-summary", false), view("order-tracking", true)],
  };
}
