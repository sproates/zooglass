import { checkpoints, fixtures, matches } from "./fixtures.js";

const byId = (id) => document.getElementById(id);
let selected = matches[0];
let view = "board";
let disconnected = false;
let checkpoint = 0;
let timer;

for (const [key, fixture] of Object.entries(fixtures)) {
  const option = document.createElement("option");
  option.value = key;
  option.textContent = fixture.label;
  byId("fixture").append(option);
}
const offlineOption = document.createElement("option");
offlineOption.value = "disconnected";
offlineOption.textContent = "Viewer disconnected";
byId("fixture").append(offlineOption);

function badge(code, away = false) {
  return `<span class="crest ${away ? "away" : ""}" aria-hidden="true">${code}</span>`;
}

function goalsMarkup(goals) {
  return goals.length
    ? goals
        .map(
          (goal) =>
            `<li><span class="minute">${goal.minute}</span><div><strong>${goal.scorer}</strong><small>${goal.detail}</small></div><span class="goal-dot" aria-hidden="true">●</span></li>`,
        )
        .join("")
    : '<li class="empty-goals">No active goals in this displayed window.</li>';
}

function renderMatches() {
  byId("matches").innerHTML = matches
    .map((match) => {
      const data = fixtures[match.fixture];
      const scores = data.score === "—" ? ["—", "—"] : data.score.split("–");
      return `<button class="match-card ${match === selected ? "selected" : ""}" data-match="${match.id}" aria-pressed="${match === selected}"><span class="card-top"><span>Match ${match.id}</span><span class="phase ${data.tone}">${disconnected ? "Saved snapshot" : `${data.clock} · ${data.phase}`}</span></span><span class="team-line">${badge(match.homeCode)}<strong>${match.home}</strong><b>${scores[0]}</b></span><span class="team-line">${badge(match.awayCode, true)}<strong>${match.away}</strong><b>${scores[1]}</b></span><span class="card-bottom">${disconnected ? "Updates unavailable" : view === "scoreboard" ? "Scoreboard view · supplied totals" : data.label}<span aria-hidden="true">↗</span></span></button>`;
    })
    .join("");
}

function renderDetail() {
  const data = fixtures[selected.fixture];
  byId("match-detail").innerHTML =
    `<div class="section-label"><span>Selected match / ${selected.id}</span><span>${disconnected ? "Saved snapshot" : "Corrected view"}</span></div><div class="featured-score"><div>${badge(selected.homeCode)}<h2>${selected.home}</h2></div><div class="score"><strong>${data.score}</strong><span>${data.clock} · ${data.phase}</span></div><div>${badge(selected.awayCode, true)}<h2>${selected.away}</h2></div></div><div class="event-callout ${data.tone}"><span class="callout-marker" aria-hidden="true">↳</span><div><h3>${data.headline}</h3><p>${data.explanation}</p></div></div><div class="goals-heading"><h3>Active home goals</h3><span>Corrected facts · baselines excluded</span></div><ul class="goals">${goalsMarkup(data.goals)}</ul>${data.gap ? `<p class="gap-note">${data.gap} A later report does not prove complete delivery.</p>` : ""}<details class="rules"><summary>Configuration behind this view</summary><dl><dt>Goal list</dt><dd>activeFacts · latestFactRevision</dd><dt>Score</dt><dd>sumActiveFacts · points</dd><dt>Initial score</dt><dd>Both baselines in the matching retained window</dd><dt>View</dt><dd>match-market / match-${Number(selected.id)}</dd></dl><p>Illustrative snapshots only. The UI displays supplied totals; it does not recalculate them.</p></details>`;
  byId("market").innerHTML =
    `<div class="section-label"><span>Independent source</span><span>Bookmaker</span></div><div class="market-title"><h2>Match result</h2><span class="market-state ${data.stale || disconnected ? "stale" : ""}">${disconnected ? "Saved" : data.stale ? "Stale" : data.market}</span></div><p class="market-basis">${data.basis}</p><div class="odds">${["Home", "Draw", "Away"].map((name, index) => `<div><span>${name}</span><strong>${data.odds[index]}</strong></div>`).join("")}</div><p class="market-description">${data.stale ? "Last reported status: open, 42 seconds ago. Silence does not confirm current prices." : data.market === "Awaiting new cycle" ? "Prior-cycle values are withheld from this new-cycle market presentation." : "Last reported decimal odds. The bookmaker owns pricing and suspension decisions."}</p><div class="market-separation"><span class="mini-line"></span><h3>Score and market arrive separately.</h3><p>A shared view does not make these feeds a single transaction. Matching sequence boundaries alone do not prove that a price is correct.</p></div><p class="fictional">Fictional prices · no bets or transactions</p>`;
}

function renderComparison() {
  const data = fixtures[selected.fixture];
  byId("comparison").innerHTML =
    `<div class="comparison-heading"><p class="eyebrow">Same publications. Different configured policies.</p><h2>${selected.home} <span>vs</span> ${selected.away}</h2><p>These are separate views of match-${Number(selected.id)}. The first-reported view is a policy comparison, not the current corrected score.</p></div><div class="policy-grid"><article class="policy corrected"><span class="policy-label">Corrected view</span><strong class="policy-score">${data.score}</strong><code>latestFactRevision</code><p>Applies accepted revisions and withdrawals.</p><ul>${data.goals.length ? data.goals.map((goal) => `<li>${goal.scorer} · ${goal.minute}</li>`).join("") : "<li>No active goals in this window</li>"}</ul></article><article class="policy original"><span class="policy-label">First-reported view</span><strong class="policy-score">${data.original}</strong><code>firstFact</code><p>Retains the first accepted create for each fact.</p><ul>${data.originalGoals.length ? data.originalGoals.map((goal) => `<li>${goal}</li>`).join("") : "<li>No active goals in this window</li>"}</ul></article></div><p class="comparison-foot">${data.explanation}</p>${selected.fixture === "transition" ? '<p class="gap-note">Retained windows differ during this failed transition. Current scorelines are withheld; listed facts belong to each view’s own window.</p>' : ""}`;
}

function render() {
  renderMatches();
  renderDetail();
  renderComparison();
  byId("board-content").hidden = view !== "board";
  byId("scoreboard-note").hidden = view !== "scoreboard";
  byId("comparison").hidden = view !== "comparison";
  byId("connection").hidden = !disconnected;
  byId("fixture").value = disconnected ? "disconnected" : selected.fixture;
  document
    .querySelectorAll("[data-view]")
    .forEach((button) =>
      button.setAttribute("aria-pressed", button.dataset.view === view),
    );
}

function applyFixture(name) {
  disconnected = name === "disconnected";
  if (!disconnected) selected.fixture = name;
  byId("notice").textContent = disconnected
    ? "Viewer disconnected. All three matches retain labelled saved snapshots."
    : `Match ${selected.id}: ${fixtures[name].notice}`;
  render();
}

function stop() {
  clearInterval(timer);
  timer = undefined;
  byId("play").textContent = "Play";
}

function showCheckpoint() {
  byId("checkpoint").textContent =
    `${checkpoint + 1} / ${checkpoints.length} · ${fixtures[checkpoints[checkpoint]].label}`;
  const atEnd = checkpoint === checkpoints.length - 1;
  byId("step").disabled = atEnd;
  byId("play").disabled = atEnd;
}

function step() {
  if (checkpoint < checkpoints.length - 1) checkpoint++;
  selected = matches[0];
  applyFixture(checkpoints[checkpoint]);
  if (checkpoint === checkpoints.length - 1) stop();
  showCheckpoint();
}

byId("matches").addEventListener("click", (event) => {
  const card = event.target.closest("[data-match]");
  if (!card) return;
  selected = matches.find((match) => match.id === card.dataset.match);
  render();
  if (matchMedia("(max-width: 650px)").matches && view !== "scoreboard") {
    byId(
      view === "comparison" ? "comparison" : "match-detail",
    ).scrollIntoView();
  }
});
document.querySelectorAll("[data-view]").forEach((button) =>
  button.addEventListener("click", () => {
    view = button.dataset.view;
    render();
  }),
);
byId("fixture").addEventListener("change", () => {
  stop();
  const name = byId("fixture").value;
  applyFixture(name);
  if (name !== "disconnected") checkpoint = checkpoints.indexOf(name);
  showCheckpoint();
});
byId("mode").addEventListener("change", () => {
  stop();
  const interactive = byId("mode").value === "interactive";
  byId("playback").hidden = !interactive;
  if (interactive) {
    checkpoint = 0;
    selected = matches[0];
    applyFixture(checkpoints[0]);
    showCheckpoint();
  }
});
byId("step").addEventListener("click", step);
byId("play").addEventListener("click", () => {
  if (timer) return stop();
  byId("play").textContent = "Pause";
  timer = setInterval(step, 3000);
});
byId("reset").addEventListener("click", () => {
  stop();
  checkpoint = 0;
  selected = matches[0];
  applyFixture(checkpoints[0]);
  showCheckpoint();
});
window.addEventListener("pagehide", stop);
render();
showCheckpoint();
