/** Startup policies used by configured scenarios; ZooGlass validates their semantics. */
export interface RuntimeField {
  sourceId?: string;
  type?: string;
  inputs?: { sourceId: string; type: string }[];
  mode: "arrival" | "latestBySequence" | "historyBySequence";
  conflict?: { mode: "sourcePriority"; sources: string[] };
  late?: { mode: "acceptLate" | "rejectBehindWatermark" };
  freshness?: { mode: "receiptAge"; staleAfterMillis: number };
}

export interface RuntimeView {
  id: string;
  fields: Record<string, RuntimeField>;
  entities?: Record<
    string,
    | { mode: "envelopeEntity" }
    | { mode: "lookupEntity"; keys: Record<string, string> }
  >;
  publication?:
    | { mode: "publishPartial" }
    | {
        mode: "requireContributions";
        fields: string[];
        maxPendingEntities: number;
      };
}

export interface RuntimeConfiguration {
  contractVersion: 2;
  storage: "memory" | "sqlite";
  maxStreams: number;
  identityWindow: number;
  maxHistoryEntries: number;
  sources: {
    id: string;
    epoch: string;
    progress?: {
      mode: "contiguousSequence";
      startSequence: number;
      maxReceivedRanges: number;
      maxMissingRanges: number;
    };
  }[];
  views: RuntimeView[];
}
