import type { SportsStep } from "./timeline.js";
const descriptions: Record<string, string> = {
  metadata: "A new synthetic match cycle begins.",
  "home-baseline": "Home baseline received; awaiting the away baseline.",
  "both-baselines": "Both baselines establish the new score window.",
  "first-goal": "Home goal reported.",
  "unknown-fact":
    "An early scorer correction is rejected until its goal arrives.",
  "delayed-create": "The delayed goal arrives.",
  "corrected-scorer": "Scorer corrected; the supplied score is unchanged.",
  withdrawal: "Goal withdrawn: corrected score recalculated by ZooGlass.",
  "obsolete-revision":
    "The late older correction cannot restore a withdrawn goal.",
  duplicate: "A repeated withdrawal has no additional effect.",
  "behind-market": "The market references an earlier feed boundary.",
  "market-watermark":
    "Bookmaker delivery progress declared; missing reports remain explicit.",
  "current-market": "A later market references the observed feed boundary.",
  "away-goal": "Away goal reported.",
  "later-away-goal": "Another away goal reported.",
  "home-goals-withdrawn":
    "All home goals withdrawn; the baseline still establishes a valid zero.",
  "all-goals-withdrawn":
    "Both supplied totals return to zero; kickoff baselines remain active.",
  "bookmaker-offline":
    "Bookmaker disconnected. Match reporting continues while odds age.",
  "second-half":
    "Second-half match metadata arrives independently of the market.",
  finished: "The synthetic match finishes; its snapshots remain available.",
  "bookmaker-reconnected":
    "Bookmaker reconnected; old odds are not refreshed by connection alone.",
  "market-refreshed": "New bookmaker report accepted.",
  retired:
    "Old facts retired across all views. Awaiting new-cycle metadata and baselines.",
  "retired-duplicate":
    "A retained duplicate receipt cannot restore retired facts.",
  "outside-retention": "A new correction to a retired goal is rejected.",
};
export function describeSportsStep(step: SportsStep) {
  return `Match ${step.entityId.slice(-1)} · Cycle ${step.cycle}: ${descriptions[step.name] ?? step.name}`;
}
