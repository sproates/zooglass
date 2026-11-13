"""Explicit preparation only: build a real-clock freshness mutant in a new copy."""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: python3 scripts/prepare-clock-leak.py NEW_DIRECTORY")
source = pathlib.Path(__file__).resolve().parents[2] / "zooglass"
root = pathlib.Path(sys.argv[1]).resolve()
root.mkdir()  # Refuse reuse of previous evidence or artifacts.
destination = root / "zooglass"
shutil.copytree(source, destination, ignore=shutil.ignore_patterns("target", ".DS_Store"))
rule = destination / "src/main/java/io/zooglass/runtime/FreshnessRuntime.java"
original = rule.read_text()
text = original
replacements = [
    ("    private Long armed;", """    private Long armed;
    // Deliberate mutant: host elapsed time incorrectly participates in expiry.
    private long hostOrigin;
    private long receiptOrigin;
    private boolean hostAnchored;"""),
    ("        replacements.forEach(deadlines::replace);", """        if (!replacements.isEmpty()) {
            hostOrigin = System.nanoTime();
            receiptOrigin = clock.monotonicMillis();
            hostAnchored = true;
        }
        replacements.forEach(deadlines::replace);"""),
    ("""        if (first == null || first > clock.monotonicMillis()) {""", """        long expiryNow = clock.monotonicMillis();
        if (hostAnchored)
            expiryNow = Math.max(expiryNow,
                    receiptOrigin + (System.nanoTime() - hostOrigin) / 1_000_000);
        if (first == null || first > expiryNow) {"""),
    ("deadlines.due(clock.monotonicMillis())", "deadlines.due(expiryNow)"),
]
for before, after in replacements:
    if text.count(before) != 1:
        raise SystemExit("Mutation target changed; inspect before preparing: " + before)
    text = text.replace(before, after)
rule.write_text(text)
(root / "mutation.json").write_text(json.dumps({
    "file": "src/main/java/io/zooglass/runtime/FreshnessRuntime.java",
    "originalSha256": hashlib.sha256(original.encode()).hexdigest(),
    "mutatedSha256": hashlib.sha256(text.encode()).hexdigest(),
    "replacements": replacements,
}, indent=2) + "\n")
subprocess.run([str(destination / "mvnw"), "-q", "-DskipTests", "package"],
               cwd=destination, check=True)
jar = destination / "target/zooglass.jar"
print(json.dumps({"jar": str(jar), "sha256": hashlib.sha256(jar.read_bytes()).hexdigest()}))
