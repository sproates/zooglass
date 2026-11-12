import {
  escape as e,
  gaps,
  goals,
  market,
  marketBasis,
  match,
  matchIds,
  pairings,
  sameWindow,
  score,
  type Goal,
  type SportsModel,
  type ViewSnapshot,
} from "./model.js";
const byId = (id: string) => document.getElementById(id)!;
const badge = (name: string, away = false) =>
  `<span class="crest ${away ? "away" : ""}" aria-hidden="true">${e(
    name
      .split(" ")
      .map((word) => word[0])
      .join("")
      .slice(0, 2),
  )}</span>`;
const names = (snapshot: ViewSnapshot | undefined, id: string) => {
  const data = match(snapshot);
  return data ? [data.home, data.away] : pairings[matchIds.indexOf(id)];
};
function phase(snapshot?: ViewSnapshot) {
  const value = score(snapshot);
  if (!value.current) return value.phase;
  const data = match(snapshot)!;
  return `${data.simulatedClock} · ${data.period === "finished" ? "Full time" : data.period === "second-half" ? "Second half" : "First half"} · Cycle ${data.cycle}`;
}
function goalList(items: Goal[]) {
  return items.length
    ? items
        .map(
          (goal) =>
            `<li><span class="minute">${e(goal.payload.minute)}′</span><div><strong>${e(goal.payload.scorer)}</strong><small>${goal.revision > 1 ? "Updated scorer" : "Goal"}</small></div><span class="goal-dot" aria-hidden="true">●</span></li>`,
        )
        .join("")
    : '<li class="empty-goals">No active goals in this displayed window.</li>';
}
function windowLabel(snapshot?: ViewSnapshot) {
  const data = match(snapshot);
  return data
    ? `Cycle ${data.cycle} · score window ${data.scoreWindowStart}`
    : "Awaiting match metadata";
}
function detail(model: SportsModel) {
  const snapshot = model.get("match-market");
  const [home, away] = names(snapshot, model.selected);
  const result = score(snapshot);
  const saved = model.saved("match-market");
  const homeGoals = goals(snapshot, "home"),
    awayGoals = goals(snapshot, "away");
  const explanation = result.current
    ? "Supplied totals and active goals reflect accepted corrections and withdrawals."
    : result.phase === "Cycle transition"
      ? "Old facts are retiring. A new score requires metadata and both baselines in the same window."
      : "A score is available once both teams have a baseline in the matching window.";
  byId("match-detail").innerHTML =
    `<button class="back-to-matches" data-back-to-matches data-focus="detail-back">← Back to matches</button><div class="section-label"><span>Selected match / ${e(model.selected)}</span><span>${saved ? "Saved snapshot" : "Corrected view"}</span></div><div class="featured-score"><div>${badge(home)}<h2>${e(home)}</h2></div><div class="score"><strong data-score>${result.home}–${result.away}</strong><span>${e(phase(snapshot))}</span></div><div>${badge(away, true)}<h2>${e(away)}</h2></div></div><div class="event-callout ${result.current ? "" : "amber"}"><span class="callout-marker" aria-hidden="true">↳</span><div><h3>${e(result.phase)}</h3><p>${explanation}</p></div></div>${(["home", "away"] as const).map((side) => `<div class="goals-heading"><h3>Active ${side} goals</h3><span>Corrected facts · baselines excluded</span></div><ul class="goals" data-goals="${side}">${goalList(side === "home" ? homeGoals : awayGoals)}</ul>`).join("")}${gaps(snapshot, "match-feed") ? `<p class="gap-note">${e(gaps(snapshot, "match-feed"))}. A later report does not prove complete delivery.</p>` : ""}<details id="match-rules" class="rules"><summary data-focus="match-rules">Configuration behind this view</summary><dl><dt>Goal list</dt><dd>activeFacts · latestFactRevision</dd><dt>Score</dt><dd>sumActiveFacts · points</dd><dt>Initial score</dt><dd>Both baselines in the matching retained window</dd><dt>View</dt><dd>match-market / ${e(model.selected)}</dd><dt>Window</dt><dd>${e(windowLabel(snapshot))}</dd></dl><ul>${[...homeGoals, ...awayGoals].map((goal) => `<li>${e(goal.payload.scorer)}: birth ${goal.birthSequence} · revision ${goal.revision}</li>`).join("")}</ul><p>ZooGlass supplies the scores. The browser filters baseline records from goal lists and checks window metadata; it does not calculate totals.</p></details>`;
  const report = market(snapshot),
    metadata = match(snapshot);
  const currentCycle =
    !!report && !!metadata && report.cycle === metadata.cycle && result.current;
  const stale = snapshot?.status.fields.market?.freshness === "stale";
  const marketState = report
    ? `${report.status === "open" ? "Open" : report.status === "suspended" ? "Suspended" : e(report.status)}${saved ? " · saved" : stale ? " · stale" : ""}`
    : "Awaiting report";
  const received = snapshot?.status.fields.market?.receivedAtMillis;
  byId("market").innerHTML =
    `<div class="section-label"><span>Independent source</span><span>Bookmaker</span></div><div class="market-title"><h2>Match result</h2><span class="market-state ${stale || saved ? "stale" : report?.status === "suspended" ? "suspended" : !currentCycle ? "waiting" : ""}">${marketState}</span></div><p class="market-basis">${e(marketBasis(snapshot))}</p><div class="odds">${(["home", "draw", "away"] as const).map((name) => `<div><span>${name[0].toUpperCase() + name.slice(1)}</span><strong>${currentCycle ? report!.odds[name].toFixed(2) : "—"}</strong></div>`).join("")}</div><p class="market-description">${!currentCycle ? "Prices are withheld until match and score windows belong to this market cycle." : stale || saved ? "Last reported prices only. Silence or viewer disconnection does not confirm current prices." : "Last reported decimal odds. The bookmaker owns pricing and suspension decisions."}${received ? ` Last accepted report: ${e(new Date(received).toLocaleTimeString())}.` : ""}</p>${gaps(snapshot, "bookmaker") ? `<p class="gap-note">${e(gaps(snapshot, "bookmaker"))}.</p>` : ""}<div class="market-separation"><span class="mini-line"></span><h3>Score and market arrive separately.</h3><p>A shared view does not make these feeds a single transaction. Matching boundaries alone do not prove that a price is correct.</p></div><details class="rules" id="market-rules"><summary data-focus="market-rules">Market delivery details</summary><p>Bookmaker basis: ${report?.basedOnMatchSequence ?? "—"} · observed feed boundary: ${snapshot?.status.inputs["match-feed"]?.observedThrough ?? "—"}</p><p>Freshness: ${e(snapshot?.status.fields.market?.freshness ?? "not observed")} · market cycle: ${report?.cycle ?? "—"}</p></details><p class="fictional">Fictional prices · no bets or transactions</p>`;
}
function comparison(model: SportsModel) {
  const corrected = model.get("match-market"),
    original = model.get("first-reported");
  const [home, away] = names(corrected, model.selected);
  const aligned = sameWindow(corrected, original);
  byId("comparison").innerHTML =
    `<button class="back-to-matches" data-back-to-matches data-focus="comparison-back">← Back to matches</button><div class="comparison-heading"><p class="eyebrow">Same publications. Different configured policies.</p><h2>${e(home)} <span>vs</span> ${e(away)}</h2><p>These are separate views of ${e(model.selected)}. First-reported is a policy comparison, not the current corrected score.</p></div><div class="policy-grid">${[
      corrected,
      original,
    ]
      .map((snapshot, index) => {
        const result = score(snapshot);
        return `<article class="policy ${index ? "original" : "corrected"}"><span class="policy-label">${index ? "First-reported view" : "Corrected view"}</span><strong class="policy-score">${aligned ? `${result.home}–${result.away}` : "—–—"}</strong><code>${index ? "firstFact" : "latestFactRevision"}</code><p>${index ? "Retains the first accepted create for each fact." : "Applies accepted revisions and withdrawals."}</p><small>${model.saved(index ? "first-reported" : "match-market") ? "Saved snapshot · " : ""}${e(windowLabel(snapshot))} · ${e(result.phase)}</small>${(
          ["home", "away"] as const
        )
          .map(
            (side) =>
              `<h3>${side === "home" ? "Home" : "Away"} goals</h3><ul>${
                goals(snapshot, side).length
                  ? goals(snapshot, side)
                      .map(
                        (goal) =>
                          `<li>${e(goal.payload.scorer)} · ${e(goal.payload.minute)}′</li>`,
                      )
                      .join("")
                  : "<li>No active goals in this window</li>"
              }</ul>`,
          )
          .join("")}</article>`;
      })
      .join(
        "",
      )}</div><p class="comparison-foot">Each score is supplied by its own subscribed view. Matching windows do not imply a cross-view transaction.</p>${!aligned ? '<p class="window-note">Views are transitioning independently. Scores are withheld; listed facts belong to each view’s own window.</p>' : ""}`;
}
export function renderSports(model: SportsModel) {
  const focused = (document.activeElement as HTMLElement | null)?.dataset.focus;
  const open = [
    ...document.querySelectorAll<HTMLDetailsElement>("details[open]"),
  ].map((node) => node.id);
  const view = model.layout === "scoreboard" ? "scoreboard" : "match-market";
  byId("matches").innerHTML = matchIds
    .map((id) => {
      const snapshot = model.get(view, id),
        result = score(snapshot);
      const [home, away] = names(snapshot, id);
      return `<button class="match-card ${id === model.selected ? "selected" : ""}" data-match="${id}" data-focus="${id}" aria-pressed="${id === model.selected}"><span class="card-top"><span>Match ${id.slice(-1)}</span><span class="phase">${model.saved(view, id) ? "Saved snapshot" : e(phase(snapshot))}</span></span><span class="team-line">${badge(home)}<strong>${e(home)}</strong><b>${result.home}</b></span><span class="team-line">${badge(away, true)}<strong>${e(away)}</strong><b>${result.away}</b></span><span class="card-bottom">${model.saved(view, id) ? "Updates unavailable" : model.layout === "scoreboard" ? "Scoreboard view · supplied totals" : e(result.phase)}<span aria-hidden="true">↗</span></span></button>`;
    })
    .join("");
  if (model.layout === "board") detail(model);
  if (model.layout === "comparison") comparison(model);
  byId("board-content").hidden = model.layout !== "board";
  byId("scoreboard-note").hidden = model.layout !== "scoreboard";
  byId("comparison").hidden = model.layout !== "comparison";
  byId("connection").textContent = model.connection;
  byId("connection").classList.toggle("live", model.connected);
  for (const id of ["match-detail", "comparison"]) {
    byId(id).tabIndex = -1;
    const [home, away] = names(model.get("match-market"), model.selected);
    byId(id).setAttribute(
      "aria-label",
      `${home} versus ${away} ${id === "comparison" ? "policy comparison" : "details"}`,
    );
  }
  document
    .querySelectorAll<HTMLElement>("[data-view]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.view === model.layout),
      ),
    );
  for (const id of open) {
    const details = document.getElementById(id) as HTMLDetailsElement | null;
    if (details) details.open = true;
  }
  if (focused)
    document
      .querySelector<HTMLElement>(`[data-focus="${focused}"]`)
      ?.focus({ preventScroll: true });
}
