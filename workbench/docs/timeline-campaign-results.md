# Document campaign results — 13 November 2026

The [document repeatability campaign](timeline-campaign.md) passed all **900 runs**
on commit `3bc584cd61584aec49f9b361803019dd27bf2493`. Each scenario/seed
combination passed its independently specified assertions and produced the same
complete semantic trace in 100 fresh Node/JVM process pairs. No failures occurred.

Nine runs were unperturbed baselines; 891 varied host delays and pacing, including
70 or 90 ms JVM pauses against a 50 ms freshness threshold. All **2,673** requested
pauses were observed at the three expected sites and virtual timestamps. Execution
ran from 2026-11-13T13:03:54.949Z to 2026-11-13T13:09:07.571Z (about 5 minutes 13 seconds).

| Scenario / seed digit  |    Passed | Semantic trace SHA-256                                             |
| ---------------------- | --------: | ------------------------------------------------------------------ |
| warehouse-retry-seed-0 | 100 / 100 | `d6ae641adfc20c94ff4b3d2de20160cb60863d7e23c6002ff4fdf009bf61bec7` |
| warehouse-retry-seed-1 | 100 / 100 | `8e1f8b87f42754881ab51e20c94638e2eb2f4173411be64b6cd07c1de72349b5` |
| warehouse-retry-seed-2 | 100 / 100 | `2be51a15b42193c65eb5c6f4bc89f163f82ee62b07c432fcc32255188c4cdf24` |
| automatic-retry-seed-0 | 100 / 100 | `d68f46a64ee3cfd82d5685c2ed3e9e688b1150ec045cb5cb3f71e643324abd86` |
| automatic-retry-seed-1 | 100 / 100 | `bf430acd1b17ac66bde0007fa70b345caa08d2abd07bc8eb68e070fa14d990ef` |
| automatic-retry-seed-2 | 100 / 100 | `9097a7a77ab0722798e376f4c488847546b8598a9047cbf50936576d136feabb` |
| delayed-links-seed-0   | 100 / 100 | `dad4b9b311cfb16d92fc0e7c9f6a6c4268bbb660a6de8671f0b7b24e2c5af4a3` |
| delayed-links-seed-1   | 100 / 100 | `57ff0d7a6656b75086752c4a592226d6b016b089f8fa2a62a6d2a1376ccd7810` |
| delayed-links-seed-2   | 100 / 100 | `8c250130c0af7888d2718fbe42e726a2229964077d928fc8725505e7a5f75d04` |

Seeds are 64 repetitions of the listed digit. Automatic-retry seeds 0 and 1
lose no receipts; seed 2 loses two and recovers on attempt three. Independent
literal digest vectors check that sequence separately from baseline equality.

## Recorded identities

- Prepared JAR: `a2d365e9777cff6a9ccd4cbedf4bf2e31e772e6ac649922ce34f310262ebd63f`.
- Workbench modules: `915501b91f5ec5fceb9b024a843392b158352d4443aac0101c1661c9a885c92b`.
- Dependency lock: `c653b8fc23a8d19d5304a377164fe170e7ca4a27024421dddf3af17329d2508a`.
- Campaign scripts: `9f7231259e95a1119b70ba371e5147171c3d19da7c1c335ff48c822fde72f866`.
- Full summary: `82f7bb63f7dfe9f377a466583c1299ad82f12c33dc0a6e42ea897a9e0e68c670`.

Environment: macOS arm64, Node 26.0.0 / V8 14.6.202.33-node.19, Homebrew
Java runtime 25.0.5.0.2 (aarch64), Europe/Gibraltar; Node locale en-US,
Java locale en-GI. All runs used the same recorded environment and executable identities.

The complete local evidence directory `timeline-document-campaign-20261113`
retains copied inputs/configuration, all 900 run files and the summary with per-run
hashes, host settings and observed pauses. The complete raw set is now retained in the
[macOS evidence archive](../evidence/README.md), alongside the identities/results
recorded here.

Validation also passed all 77 timeline tests, TypeScript checks, lint and formatting.
The tests include negative controls for missing pause observations and changed
traces, plus replay pass-policy tests covering success, reproduced assertion/budget
failure, divergence and invalid/incomplete evidence. Tests consumed a separately
prepared JAR and did not build Java.

These results qualify the selected scenarios in the admitted memory-runtime profile
under this environment. They are empirical evidence, not a mathematical proof or
cross-environment, persistence/restart or wall-clock rollback qualification.
