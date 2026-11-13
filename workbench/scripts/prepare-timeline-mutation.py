"""Explicit preparation only: copy sources and build an expiry mutation outside the checkout."""
import pathlib
import shutil
import subprocess
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: python3 scripts/prepare-timeline-mutation.py NEW_DIRECTORY")
source = pathlib.Path(__file__).resolve().parents[2] / "zooglass"
destination = pathlib.Path(sys.argv[1]).resolve() / "zooglass"
if destination.exists():
    raise SystemExit("Destination must not exist")
shutil.copytree(source, destination, ignore=shutil.ignore_patterns("target", ".DS_Store"))
rule = destination / "src/main/java/io/zooglass/runtime/FreshnessRuntime.java"
text = rule.read_text()
original = "winner.withAge(winner.age().stale())"
if text.count(original) != 1:
    raise SystemExit("Expiry mutation target changed; inspect before preparing")
rule.write_text(text.replace(original, "winner.withAge(winner.age())"))
subprocess.run([str(destination / "mvnw"), "-q", "-DskipTests", "package"], cwd=destination, check=True)
print(destination / "target/zooglass.jar")
