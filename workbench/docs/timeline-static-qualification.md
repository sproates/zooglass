# Static-view qualification

The [accepted configuration expansion](../../docs/design/timeline-configuration-expansion.md)
has one fixed qualification boundary: five converted legacy scenarios and the
[independent mixed-mode witness](../scenarios/timeline-static/mixed-modes/ORACLE.md).
This guide describes the qualification tools; results and archived evidence are
pending. Final promotion to main is a separate decision.

## Fixed matrix

| Part                              | Scenario executions | Required evidence                                                    |
| --------------------------------- | ------------------: | -------------------------------------------------------------------- |
| Six cases, baseline and perturbed |                  12 | Literal outcomes, complete traces and measured pauses                |
| Strict replay of each run         |                  12 | Newly executed records match every saved record; outcome passed      |
| Normal and wrong-selection hosts  |                   2 | Normal passes; mutant fails the older-input checkpoint               |
| Ordinary-service comparisons      |                   2 | Late-update and mixed-modes data/receipt agreement at named barriers |
| Total                             |              **28** | All checks required                                                  |

Focused tests and CI are separate from this matrix. There is no seed multiplier:
these inputs contain no random faults. Each timeline execution creates a fresh
JVM; this count does not claim a particular number of operating-system processes.

The perturbed runs request 70 ms Node command delays, 70 ms idle delays, paced
execution and 90 ms JVM pauses. The checker requires measured in-turn Node delays
over 50 ms at every publication timestamp and a JVM pause at the first state effect. The
subscribed mixed-mode witness also requires the first client writer-handoff pause;
the converted cases have no subscribers and therefore no client writer pause. It checks the complete literal assertions as well as baseline trace
identity. Missing or short pause evidence is a failure. The Node threshold allows timer
quantization around the requested 70 ms; JVM pauses must meet their requested 90 ms. No alarm pause is expected:
this family has unspecified freshness and schedules no expiry timer.

The mixed-mode control reuses the isolated preparation recipe that removes the
`LatestBySequence` guard, causing that implementation to replace on arrival. The
prepared source, nested runtime and host inventories must show exactly the
allowed selection-class change. Normal and mutant use the identical reviewed
scenario/configuration. The mutant must reach `data-a-11` at 30 ms and retain
A11 as latest instead of A12, while arrival and history still match. Earlier
semantic records must agree. This is an actual runtime mutation, not an altered
expected answer or a manually damaged trace.

The two ordinary-service comparisons reuse exact selected configuration bytes,
source publications and literal data checks from the reviewed documents. They
exercise real sockets and HTTP reads at named barriers, retaining complete
observations. They do not claim deterministic transport timing or equality of
cross-socket event ordering with the timeline trace.

## Reproduce

Use the [prepared-artifact setup](timeline-guide.md). Tests and runners never
build Java. Run qualification from a clean committed checkout; each runner retains
source/artifact/input identities and rejects source changes during execution.
Output directories must be new.

From `workbench/`:

```sh
mkdir /tmp/static-evidence
npm run timeline:static-campaign -- /tmp/static-evidence/campaign
python3 scripts/prepare-fleet-strategy-mutation.py /tmp/static-selection-prepared
npm run timeline:static-selection-control -- /tmp/static-selection-prepared /tmp/static-evidence/control
npm run timeline:static-service-parity -- late-update /tmp/static-evidence/service-late-update ../zooglass qualification
npm run timeline:static-service-parity -- mixed-modes /tmp/static-evidence/service-mixed-modes ../zooglass qualification
npm run timeline:static-audit -- /tmp/static-evidence /tmp/static-evidence/audit.json
```

The existing preparation script's historical Fleet name describes its original
caller; the isolated `LatestBySequence` mutation is shared by both witnesses.
It explicitly builds normal/mutant artifacts outside the production checkout.
Its preparation manifest records the recipe, commands, Java source revision and
artifact hashes. It does not execute either scenario.

Qualification retains exact fixture inputs, conversion provenance, raw runs,
replay results including freshly executed traces, timing diagnostics, control
preparation evidence, service observations and summary hashes. Archives belong
in GitHub Release assets; only their manifests, hashes and download links belong
in Git. See [evidence verification](../evidence/README.md).

This boundary covers the declared memory/static family and the five explicit
conversions. It does not establish arbitrary Workbench configurations, a DSL,
performance, cross-platform trace equality or deterministic HTTP/WebSocket timing.
