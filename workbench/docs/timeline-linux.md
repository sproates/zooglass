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

## Recorded results, 13 November 2026

All **900 runs passed**, with complete matching semantic traces within each of
the nine scenario/seed groups and all **2,673** requested JVM pauses observed.
All **84 timeline tests passed** before the campaign. Tests took 53 seconds;
the campaign ran from 13:48:48.082Z to 13:55:43.157Z (about 6 minutes 55 seconds).
The container used three CPUs and a 2 GiB memory limit.

The runtime checkout was clean at `1ac7506d13b7ba858a6a47e9c8249048cb6abe15`.
Later archive/tool/documentation changes do not change the tested runtime.
Environment: Linux arm64, Node 26.13.1 / V8 14.6.202.34-node.40, Eclipse Adoptium
Java 25.0.5+8-LTS (aarch64), UTC and en-US locales.

| Scenario / seed digit  |    Passed | Semantic trace SHA-256                                             |
| ---------------------- | --------: | ------------------------------------------------------------------ |
| warehouse-retry-seed-0 | 100 / 100 | `5a487c9675d933ed015e9f79a77b53890bfd40144173097f35b3d20ac036fe8b` |
| warehouse-retry-seed-1 | 100 / 100 | `957b6e160b777abc3b33e12f456b111c6211e21136ba34f06af23c9ade95e178` |
| warehouse-retry-seed-2 | 100 / 100 | `10cbb634797d9307ac25f6bbe846f5b266fedd34ad51a40d025aa0c7ca6e1662` |
| automatic-retry-seed-0 | 100 / 100 | `ee3afb319e97f0bf1a4f1c557bfa7ef7efd0f857b3345f5ee9c762cf55297b72` |
| automatic-retry-seed-1 | 100 / 100 | `ddf5af5cabefd2ed684a8017e096a3ac772d504ecc482ebe1725b17496f5e265` |
| automatic-retry-seed-2 | 100 / 100 | `d0e26dea989dcf6be21788f293b70f38c1dbd14994bae14376b61de917733e3b` |
| delayed-links-seed-0   | 100 / 100 | `208e2a42da01e51bf975bf8a616625b242c887efab3f061582e03592a5a48045` |
| delayed-links-seed-1   | 100 / 100 | `2fddaa29c2477715e528844a4baa39530ee3e447305940efbfcad2d18b933d28` |
| delayed-links-seed-2   | 100 / 100 | `eae998dceb029f731a844f5a16e8a37c11062863a1055f7269e93574d492fa0c` |

Seeds repeat the listed digit 64 times. As in the macOS campaign, these nine cells
represent about four behavioural cases: only automatic retry has seeded loss,
with two selected loss patterns. This is repetition/perturbation evidence, not
nine different feature implementations.

Recorded identities:

- Docker image: `sha256:0ea9ab78419daff90565a7e82f9fb9a650a26aa7944a467272e00dadd88b0555`.
- Prepared JAR: `f69aaa60db38bfe2400632144a58989341c6cd121ba7d9de4e671418662c6819`.
- Workbench modules: `a21215270d9467c03ce9c69bdecf7e6ed87fc05b7a26de239932135328bab7e4`.
- Dependency lock: `c653b8fc23a8d19d5304a377164fe170e7ca4a27024421dddf3af17329d2508a`.
- Campaign summary: `897112b6270845efc8587601b4a309ce41267f3f04d06ca03c7073379d3d445a`.

The [Linux raw evidence archive](../evidence/README.md) retains all 900 runs,
copied inputs, summary, logs and environment metadata as GitHub Release assets. Both Linux and
macOS have independently passed their selected campaigns. Replay still requires
matching recorded environments; this is not a cross-platform equality guarantee,
nor SQLite/restart qualification.
