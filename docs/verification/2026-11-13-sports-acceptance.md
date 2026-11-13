# Sports demo acceptance record

Final acceptance of the bounded Sports demo was merged into the shared Order and
Sports delivery branch in [PR #167](https://github.com/sproates/zooglass/pull/167).
Final head `bf09373` passed [CI](https://github.com/sproates/zooglass/actions/runs/43339367972).
Both Sports modes and the evidence below are accepted there. The combined
programme still needs its separate delivery PR and approval before reaching main.

Runtime baseline: `731f886`, after the interactive delivery in
[PR #166](https://github.com/sproates/zooglass/pull/166). Its reviewed head `c8458ea`
passed all eleven checks in [final-head CI](https://github.com/sproates/zooglass/actions/runs/43327002882),
after a failed-job retry for an existing Fleet test deadline. Sports cases passed
both attempts. This acceptance change adds verification and documentation only.

## Evidence

| Requirement | Observable evidence |
| --- | --- |
| Three complete cycles | [Source acceptance](../../workbench/test/scenarios/sports-simulation.test.ts) checks hand-written expected lists/totals, policy-specific target receipts, early revision rejection and exact retry, obsolete corrections, duplicates, progress and cycle transitions. It also checks real receipt-age expiry and reconnect without refresh. |
| Returning and late viewers | [Browser acceptance](../../workbench/test/browser/sports-acceptance.test.ts) now finishes three cycles with an existing viewer disconnected, then checks the first baseline for all nine view/entity pairs in returning and new viewers. Full envelopes match independent HTTP reads; literal cycle-3 totals, scorers, floors, source boundaries, settled stale markets and permanent bookmaker gaps are asserted without another source publication. |
| Retained-state soak | [Forty-cycle bounds](../../workbench/test/scenarios/sports-bounds.test.ts) runs beyond the 128-identity window and inspects SQLite after shutdown: nine view/entity rows, three matches, six streams, bounded fact/tombstone records, 128 retained receipts per stream and bounded progress ranges. |
| Retirement safety | [Retirement checks](../../workbench/test/scenarios/sports-retirement.test.ts) reject partial success and incorrect controls/floors, retry a lost committed acknowledgement exactly, and require every view to retire before the next metadata. Source acceptance distinguishes old duplicate receipts from fresh corrections to retired births. |
| Finite walkthrough | [Interactive acceptance](../../workbench/test/browser/sports-interactive.test.ts) covers 21 checkpoints, Step/Play/Pause, pending-check cancellation, fresh-store Reset, multiple viewers, same first-cycle deliveries, failure visibility and retryable failed startup. Results stay visible at completion. |
| New match and policy view | [Extension acceptance](../../workbench/test/scenarios/sports-extension.test.ts) adds match-4 and `first-score` through startup configuration, publishes independent events, and checks the corrected and first-fact outcomes plus duplicate retry. No core projection is added. |
| Presentation | Three-engine browser checks cover supported startup, responsive views, focus and controls below domain content at widths 360–1440. Current clean-command desktop/phone captures are linked below. |

The [developer-value comparison](../sports-developer-value.md) points to exact
configurations and consumer bindings, shows one publication's policy-specific
outcomes and explains what extending the application actually requires.

## State and queue bounds

| Scope | Bound and evidence |
| --- | --- |
| Match population | Three synthetic match IDs reused across cycles, three views and nine persisted view/entity rows. |
| Source identities | Two source/entity streams per match, six total; `maxStreams: 16`, `identityWindow: 128`. The stopped soak inspects all six streams and retained receipts. |
| Facts and tombstones | Each fact field configures a limit of 16. This schedule retains at most three births per home/away field, including withdrawals; all stored births are at or above that field's floor. Scoreboard has two fact fields; the other two views have four. |
| Progress | Both sources use contiguous progress with at most 16 received and 16 missing ranges. The soak observes at most one missing range per input and at most two persisted received ranges. The first-cycle bookmaker gap eventually becomes expired evidence. |
| Producer work | Lazy schedule over three fixed match objects; each retains six named publication envelopes for corrections/retries and emits at most two actions per step. No growing replay history or delayed-event queue. Two source clients plus bounded request-scoped control sockets are closed with the run. |
| Page state | Nine latest snapshots and a 20-entry notice feed. Production rendering does not retain per-update history. Test observation buffers are separate. |
| Delivery | Shared ZooGlass queue defaults are 128 messages and 1 MiB per connection. The proxy has no replay buffer and rejects over 1 MiB pending output; a 1 MiB frame limit can admit one further frame before the next pending-output check. These are per-connection bounds, not a global viewer limit. |
| Interactive controls | At most 16 control connections, two pending commands each, 1,024-character ordinary commands and a 64 KiB WebSocket frame limit. Pending control output over 64 KiB closes that connection. |

Shared queue behaviour is covered by [slow-receiver acceptance](../../workbench/test/concurrent-clients.test.ts)
and [outbound queue tests](../../zooglass/src/test/java/io/zooglass/delivery/OutboundQueueTests.java).
The soak demonstrates retained-state counts, not peak memory, disk-size plateau,
throughput or unlimited viewers. SQLite inspection follows shutdown because the
running service holds its store lock.

## Reproduce the focused acceptance

Use Node 26 and JDK 25, install dependencies and browser engines as described in
the [Sports guide](../../demos/live-sports/README.md), and prepare the service JAR
explicitly beforehand. Tests never invoke a Java build. From `workbench/`:

```sh
npm run build:browser
npx tsx --test test/scenarios/sports-simulation.test.ts test/scenarios/sports-bounds.test.ts test/scenarios/sports-retirement.test.ts test/scenarios/sports-extension.test.ts
npx tsx --test --test-name-pattern='three completed cycles' test/browser/sports-acceptance.test.ts
```

The final local acceptance passed eight existing source/bounds/retirement tests,
the new configuration-extension case and the new three-cycle browser recovery case.
The broader interactive/three-engine suite is backed by the delivered slice's
reviewed green CI rather than claimed as another full local rerun here.

## Clean-command walkthrough

On 13 November 2026, an exported copy of runtime baseline `731f886` began without
`node_modules` or generated browser assets. `npm ci` installed the locked dependencies;
a prepared JAR was copied to `zooglass/target/zooglass.jar`. No Java build ran.
The environment was macOS with Node 26.0.0, Homebrew JDK 25.0.5 and installed
Playwright browsers. Dependency/browser caches were available: this is clean
project setup, not a fresh machine or offline-install qualification.

```sh
npm run demo -- live-sports --continuous
npm run demo -- live-sports --interactive
```

The actual commands built browser assets and printed ordinary loopback URLs.
Continuous mode displayed live match scores without playback controls and stopped
on SIGINT. Interactive mode completed 21/21 checks, kept its fresh-cycle 0–0
results visible, reset to empty views at the same URL, and quit through terminal
input. Both commands exited successfully, their viewer/service ports closed and
no page errors were observed.

Captures: continuous [desktop](../../demos/live-sports/docs/images/acceptance-continuous-desktop.png)
and [phone](../../demos/live-sports/docs/images/acceptance-continuous-phone.png);
completed interactive [desktop](../../demos/live-sports/docs/images/acceptance-interactive-desktop.png)
and [phone](../../demos/live-sports/docs/images/acceptance-interactive-phone.png).

## Limits retained at acceptance

The matches, clocks and bookmaker odds are synthetic. There is no betting,
external sports feed, pricing validation or production integration. First-reported
is an illustrative revision policy, not a claim about the current correct score.

Independent views and inputs are not an atomic cross-source or cross-view
transaction. A market basis is the bookmaker's stated feed boundary; neither equal
boundaries nor complete delivery proves correct prices. Freshness is receipt age,
not source health or match time. Empty, retired and incomplete baseline states must
not be presented as a valid 0–0. Retained duplicates may return historic receipts
without restoring retired facts.

General producer-process recovery, automatic service restart per cycle, dynamic
match/view management, authentication and production deployment remain outside
this demo. The fixed roster and capacity budgets require deliberate changes when
extending it. This record does not claim full accessibility, physical-phone
qualification or testing of every historical minimum browser release.
