# Restart wall-clock negative control

The [memory restart scenario](../scenarios/simulation/memory-restart.json) expects
the generation-2 publication at global time 50 to carry receipt wall time
`1700000000050`. The control changes only the runtime clock adapter in an isolated
host build. The mutant computes wall time from elapsed generation time, so the
publication retains the correct data, version and freshness status but carries
`1700000000000`. The bridge still reports the correct generation start and wall
clock because its clock calculation is separate from the runtime adapter.

From `workbench/`, use JDK 25, Node 26 and Python 3.12 or later on macOS or Linux.
Both output directories must be new.

```sh
npm run prepare:generation-clock-control -- /tmp/prepared-generation-clock
npm run timeline:generation-clock-control -- /tmp/prepared-generation-clock /tmp/generation-clock-evidence
```

Preparation builds the committed Java tree in an isolated directory and installs
the core once. It builds both hosts against that same core and checks that the
receipt clock is the only changed host class. The checker and tests consume the
prepared artifacts without invoking Maven.

The normal run must pass. Two mutant runs must fail `fresh-after-restart`, one
with 70 ms Node delays and 90 ms JVM pauses. The checker verifies that both mutant
traces match and that the failed assertion differs only in the receipt wall time.
The evidence directory contains all three raw runs, the retained inputs, the
clock source pair and build provenance. Its summary records execution identities
and the first differing semantic record after the artifact-specific header.
