import type { SourcePublication } from "../../execution/publication-receipt.js";
import { matchIds } from "./configuration.js";

export type FactOutcome = "create" | "correct" | "obsolete" | "outside";
export type SportsAction =
  | {
      kind: "publish";
      event: SourcePublication;
      outcome?: FactOutcome;
      duplicate?: boolean;
    }
  | { kind: "retire"; entityId: string; minimumBirthSequence: number }
  | { kind: "watermark"; entityId: string; throughSequence: number }
  | { kind: "disconnect" | "reconnect" };
export interface SportsStep {
  cycle: number;
  name: string;
  entityId: string;
  actions: SportsAction[];
}
const teams = [
  ["Harbour Athletic", "Hilltown"],
  ["Riverside", "Northbridge"],
  ["Westfield", "Kingsford"],
];

/** One allocator per source/entity, shared by all event types; omissions reserve real identities. */
class MatchSchedule {
  sequence = 0;
  marketSequence = 0;
  floor = 1;
  firstGoal!: SourcePublication;
  secondGoal!: SourcePublication;
  earlyRevision!: SourcePublication;
  lateRevision!: SourcePublication;
  withdrawal!: SourcePublication;
  awayGoal!: SourcePublication;
  constructor(
    readonly entityId: string,
    readonly index: number,
  ) {}
  publication(
    type: string,
    payload: object,
    fact?: SourcePublication["fact"],
  ): SourcePublication {
    const publicationSequence = ++this.sequence;
    if (!Number.isSafeInteger(publicationSequence))
      throw new Error("Sports publication sequence exhausted.");
    return {
      sourceId: "match-feed",
      epoch: "run",
      entityId: this.entityId,
      publicationSequence,
      type,
      payload,
      ...(fact ? { fact } : {}),
    };
  }
  create(side: string, cycle: number, scorer?: string): SourcePublication {
    return this.publication(
      `${side}.contribution`,
      scorer
        ? {
            kind: "goal",
            cycle,
            scorer,
            minute: 12 + this.index * 7,
            points: 1,
          }
        : { kind: "baseline", cycle, points: 0 },
      { birthSequence: this.sequence + 1, revision: 1, operation: "create" },
    );
  }
  revise(
    event: SourcePublication,
    revision: number,
    scorer?: string,
  ): SourcePublication {
    return this.publication(
      event.type,
      scorer ? { ...event.payload, scorer } : {},
      {
        birthSequence: event.fact!.birthSequence,
        revision,
        operation: scorer ? "revise" : "retract",
      },
    );
  }
  match(cycle: number, period = "first-half"): SourcePublication {
    return this.publication("match.state", {
      cycle,
      home: teams[this.index][0],
      away: teams[this.index][1],
      period,
      simulatedClock:
        period === "finished"
          ? "90:00"
          : period === "second-half"
            ? "45:00"
            : "00:00",
      scoreWindowStart: this.floor,
      observedAt: Date.now(),
    });
  }
  market(cycle: number, basedOnMatchSequence: number): SourcePublication {
    if (!Number.isSafeInteger(++this.marketSequence))
      throw new Error("Sports market sequence exhausted.");
    return {
      sourceId: "bookmaker",
      epoch: "run",
      entityId: this.entityId,
      publicationSequence: this.marketSequence,
      type: "market.state",
      payload: {
        cycle,
        status: "open",
        odds: { home: 2.1 + this.index / 10, draw: 3.2, away: 3.4 },
        basedOnMatchSequence,
        observedAt: Date.now(),
      },
    };
  }
}
const publish = (
  event: SourcePublication,
  outcome?: FactOutcome,
): SportsAction => ({ kind: "publish", event, outcome });

/** Finite and continuous runs advance the same bounded, lazy checkpoint schedule. */
export function* sportsTimeline(cycles = Infinity): Generator<SportsStep> {
  const matches = matchIds.map((id, index) => new MatchSchedule(id, index));
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const step = (
      m: MatchSchedule,
      name: string,
      ...actions: SportsAction[]
    ): SportsStep => ({ cycle, name, entityId: m.entityId, actions });
    if (cycle > 1) {
      for (const m of matches) {
        m.floor = m.sequence + 1;
        yield step(m, "retired", {
          kind: "retire",
          entityId: m.entityId,
          minimumBirthSequence: m.floor,
        });
        // Within the identity window: old receipts survive retirement but cannot restore facts.
        if (cycle === 2) {
          yield step(m, "retired-duplicate", {
            kind: "publish",
            event: m.firstGoal,
            outcome: "create",
            duplicate: true,
          });
          yield step(
            m,
            "outside-retention",
            publish(m.revise(m.firstGoal, 4, "Alex Vale"), "outside"),
          );
        }
      }
    }
    for (const m of matches) yield step(m, "metadata", publish(m.match(cycle)));
    for (const m of matches)
      yield step(
        m,
        "home-baseline",
        publish(m.create("home", cycle), "create"),
      );
    for (const m of matches)
      yield step(
        m,
        "both-baselines",
        publish(m.create("away", cycle), "create"),
        publish(m.market(cycle, m.sequence)),
      );
    for (const m of matches) {
      m.firstGoal = m.create("home", cycle, "Alex Vale");
      yield step(m, "first-goal", publish(m.firstGoal, "create"));
    }
    for (const m of matches) {
      m.secondGoal = m.create("home", cycle, "Sam Reed");
      m.earlyRevision = m.revise(m.secondGoal, 2, "Taylor Brook");
      yield step(
        m,
        "unknown-fact",
        publish({ ...m.earlyRevision, expectedRejection: "unknownFact" }),
      );
    }
    for (const m of matches)
      yield step(m, "delayed-create", publish(m.secondGoal, "create"));
    for (const m of matches)
      yield step(m, "corrected-scorer", publish(m.earlyRevision, "correct"));
    for (const m of matches) {
      m.lateRevision = m.revise(m.firstGoal, 2, "Alex Vale-Smith");
      m.withdrawal = m.revise(m.firstGoal, 3);
      yield step(m, "withdrawal", publish(m.withdrawal, "correct"));
    }
    for (const m of matches)
      yield step(m, "obsolete-revision", publish(m.lateRevision, "obsolete"));
    for (const m of matches)
      yield step(m, "duplicate", {
        kind: "publish",
        event: m.withdrawal,
        outcome: "correct",
        duplicate: true,
      });
    for (const m of matches) {
      if (cycle === 1) m.market(cycle, m.sequence); // Deliberately omitted bookmaker publication 2.
      yield step(
        m,
        "behind-market",
        publish(m.market(cycle, m.earlyRevision.publicationSequence)),
      );
      yield step(m, "market-watermark", {
        kind: "watermark",
        entityId: m.entityId,
        throughSequence: m.marketSequence,
      });
      yield step(m, "current-market", publish(m.market(cycle, m.sequence)));
    }
    for (const m of matches) {
      m.awayGoal = m.create(
        "away",
        cycle,
        ["Jordan Hill", "Robin Lane", "Casey Park"][m.index],
      );
      yield step(m, "away-goal", publish(m.awayGoal, "create"));
    }
    // One match returns to a valid 0–0 with both zero-point baselines still active.
    yield step(
      matches[0],
      "home-goals-withdrawn",
      publish(matches[0].revise(matches[0].secondGoal, 3), "correct"),
    );
    yield step(
      matches[0],
      "all-goals-withdrawn",
      publish(matches[0].revise(matches[0].awayGoal, 2), "correct"),
    );
    yield step(
      matches[2],
      "later-away-goal",
      publish(matches[2].create("away", cycle, "Morgan Stone"), "create"),
    );
    yield step(matches[0], "bookmaker-offline", { kind: "disconnect" });
    // With default pacing these staggered updates keep scores moving during >15 seconds of silence.
    for (const m of matches)
      yield step(m, "second-half", publish(m.match(cycle, "second-half")));
    for (const m of matches)
      yield step(m, "finished", publish(m.match(cycle, "finished")));
    yield step(matches[0], "bookmaker-reconnected", { kind: "reconnect" });
    for (const m of matches)
      yield step(m, "market-refreshed", publish(m.market(cycle, m.sequence)));
  }
}
