# Fleet wrong-strategy control

This negative control leaves the valid fleet configuration and literal expectations
unchanged. In an isolated source archive it removes the ordering guards from
production `LatestBySequence.evaluate`, retaining unconditional replacement with
the incoming copy. Both runtime classifiers and simulation hosts are built
explicitly. The checkout's production sources remain unchanged.

From a clean committed checkout, in `workbench/`:

```sh
python3 scripts/prepare-fleet-strategy-mutation.py /tmp/fleet-strategy-prepared
node --import tsx scripts/fleet-strategy-check.ts /tmp/fleet-strategy-prepared /tmp/fleet-strategy-evidence
```

Both directories must be new. Preparation runs Maven serially in the isolated
archive with its own repository. The checker and tests never build Java.
Preparation requires committed production/host sources. Development smoke runs
may use edited Workbench tools; the summary records tracked changes and hashes
all relevant untracked files. Before/after checks reject source drift during a run.
Final qualification uses a clean committed checkout with no relevant untracked
files; a successful dirty smoke is not final qualification.

The normal fleet must pass. Ordinary and paused mutants must fail at `frames-240`,
the complete cumulative client-frame assertion after accepted late position 41.
Normal selection remains position 42 at version 7. The mutant emits position 41
at version 9 while ordered journey remains correct. Admission, identity and
infrastructure failures cannot satisfy the control. Node ingress delay at virtual
240 ms and the JVM's first state-effect pause at 60 ms must be observed. Both
mutants must produce exactly the same wrong semantic trace.

Preparation records source revision/archive, recipe/helper hashes, exact source
patch, commands, Java version and artifact hashes. The checker opens both hosts
and their nested production runtimes. Apart from Maven `pom.properties` metadata,
only the nested runtime may change in the host, and only `LatestBySequence.class`
may change inside that runtime. Class and runtime hashes, unchanged layouts and
the exact source patch against Git are verified. A second read after execution
detects changed artifacts or inputs.

Evidence retains three runs, canonical inputs, original/mutated source, preparation
manifest and a summary containing source, input and output hashes. Final evidence
requires a clean committed checker head whose production/host Git tree matches
the preparation revision. Both revisions are retained; documentation or tool-only
commits do not require rebuilding identical Java sources. This control
establishes sensitivity to this deliberate fault, not other strategies or platforms.
