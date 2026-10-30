# CI checks

CI runs when a pull request is opened or updated. It uses the changed files to
choose the checks needed. Documentation edits don't need browser tests.

## Branch shortcuts

For development PRs, use a whole segment in either branch name:

| Example                      | Checks                                                      |
| ---------------------------- | ----------------------------------------------------------- |
| `feature/strategies`         | Normal checks for the changed files                         |
| `feature/core-ci/strategies` | ZooGlass Java tests only, plus CI setup and document checks |
| `feature/no-ci/strategies`   | None; the workflow appears as skipped and starts no runners |

No configuration or policy PR is needed. If both shortcuts appear, `no-ci` wins.

**PRs into `main` ignore both shortcuts.** They run the normal checks for the
complete PR diff. This means nothing required is skipped, not that every test
runs for every change.

Main requires an up-to-date passing `validation-gate` before merging. There is
no second automatic run after merge: the PR has already checked those changes
against current main.

## The baseline

The executable map is [selection.mjs](../.github/ci/selection.mjs).
Its [tests](../.github/ci/selection.test.mjs) give concrete examples.

| Change                                       | Normal checks                                                 |
| -------------------------------------------- | ------------------------------------------------------------- |
| Markdown and recognised documentation images | Document links and CI selection tests                         |
| ZooGlass Java tests                          | Java tests                                                    |
| Known field-update and view-store code       | Java and Workbench real-service tests                         |
| Known transport code                         | Java, real-service and browser tests                          |
| Demo UI                                      | Workbench, demo and browser checks, including browser engines |
| CI, dependencies or unclassified code        | All suites                                                    |

Mixed changes combine the required checks. The Actions selection summary shows
what was selected and why. See [Testing](testing.md) for suite commands and coverage.

## Run everything manually

In GitHub Actions, open **Validation**, choose **Run workflow**, select the branch
and leave the scope as **full**. This works even on shortcut branches.

Manual runs report `manual-validation`; they don't replace a PR's required gate.
