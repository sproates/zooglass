# CI rollout verification, 30 October 2026

Historical record: the policy-based mechanism described below has been replaced
by the [branch conventions](../ci-validation.md).

Selection and checkpoint controls were delivered in PRs #107 and #109, followed
by the acceptance corrections in #112. Main requires an up-to-date passing
`validation-gate` and a PR, including for admins. Manual checks use a different
name and cannot replace that gate. No batch deferral remains enabled after the
temporary acceptance entry was removed in PR #112.

| Exercise | Observed result |
| --- | --- |
| [Documentation-only PR](https://github.com/sproates/zooglass/actions/runs/40989475392) | Selection and gate passed; no application suites ran. |
| [Core-only selection](https://github.com/sproates/zooglass/actions/runs/40989672903) | Selected Java/core only. Superseded after capturing the plan; cancelled required work correctly failed the gate. |
| [UI-only selection](https://github.com/sproates/zooglass/actions/runs/40989780308) | Selected consumer checks, without Java/native. Superseded after plan capture. |
| [Mixed selection](https://github.com/sproates/zooglass/actions/runs/40990150364) | Combined Java and consumer checks; cancelled after plan capture. |
| [Deferred integration slice](https://github.com/sproates/zooglass/actions/runs/40990332681) | Java/core and both gates passed; browser deferral was explicit. Core job took 1m49s. |
| [Final integration checkpoint](https://github.com/sproates/zooglass/actions/runs/40990792636) | All suites restored and passed, including browser/platform jobs. |
| [Manual selected dispatch](https://github.com/sproates/zooglass/actions/runs/40990938415) | Selection and `manual-validation` passed with an empty comparison diff. Full dispatch selection is also covered by the CLI tests. |

The first main-push run exposed a fixture test inheriting its caller's event
context. It failed closed. The failure was reproduced before isolating the fixture
variables, then all selector tests passed under both push and dispatch contexts.
An unknown text-fixture case likewise failed before its classification fix and
passed afterwards. These corrections retain conservative selection for unknown
inputs. Temporary probe PRs were closed without merging their fixture edits to main.

The [final correction run](https://github.com/sproates/zooglass/actions/runs/40991255418)
passed all existing behavioural suites and both gates. The local selector/policy
suite contains 18 tests. See the [workflow guide](../ci-validation.md) for usage.
