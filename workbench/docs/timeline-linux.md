# Linux timeline qualification

The qualification environment is Linux arm64 in Docker, using pinned Node and
Temurin JDK base-image digests in `scripts/linux-timeline.Dockerfile`. The Dockerfile
installs Git, curl and CA certificates; it does not build ZooGlass or run tests.
Record the resulting image ID as well: distribution packages are not snapshot-pinned.

Use a separate clean checkout with its own dependencies and build outputs:

```sh
docker build --platform=linux/arm64 -f workbench/scripts/linux-timeline.Dockerfile -t zooglass-timeline-linux workbench/scripts
docker run --rm --platform=linux/arm64 -v /ABSOLUTE/CHECKOUT:/workspace zooglass-timeline-linux npm ci --ignore-scripts
docker run --rm --platform=linux/arm64 -v /ABSOLUTE/CHECKOUT:/workspace zooglass-timeline-linux npm run prepare:timeline
docker run --rm --platform=linux/arm64 -v /ABSOLUTE/CHECKOUT:/workspace zooglass-timeline-linux npm run test:timeline
docker run --rm --platform=linux/arm64 -v /ABSOLUTE/CHECKOUT:/workspace -v /ABSOLUTE/NEW_EVIDENCE_PARENT:/evidence zooglass-timeline-linux npm run timeline:document-repeat -- /evidence/campaign
```

Artifact preparation is explicit and separate. Tests and campaigns only consume
the prepared JAR. The campaign output directory must not already exist.

The declared campaign is 100 repetitions per scenario/seed combination: 900 fresh
Node/JVM pairs, three bounded workers, independent assertions and draw vectors,
and the same pause coverage checks as the macOS campaign. Compare traces within
each Linux scenario/seed group. Do not compare Linux hashes with macOS hashes or
infer a cross-environment replay guarantee. Archive the complete results with
their environment and executable identities using the
[evidence archive workflow](../evidence/README.md).
