"""Explicit preparation only: build two isolated hosts that differ by one clock method."""
import hashlib
import io
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tarfile
import zipfile


SOURCE_FILE = (
    "simulation-host/src/main/java/io/zooglass/runtime/ControlledReceiptClock.java"
)
CLASS_FILE = "BOOT-INF/classes/io/zooglass/runtime/ControlledReceiptClock.class"
BEFORE = b"return generation.wallMillis(turns.now());"
AFTER = b"return Math.addExact(generation.epochMillis(), monotonicMillis());"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def maven(args, source, repository):
    command = ["./mvnw", "--batch-mode", f"-Dmaven.repo.local={repository}", *args]
    with subprocess.Popen(command, cwd=source, start_new_session=True) as process:
        try:
            code = process.wait(timeout=300)
        except BaseException:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=10)
            raise
    if code:
        raise subprocess.CalledProcessError(code, command)
    return command


def jar_inventory(path):
    with zipfile.ZipFile(path) as jar:
        names = [name for name in jar.namelist() if not name.endswith("/")]
        if len(names) != len(set(names)):
            raise ValueError("Host artifact has duplicate entries")
        inventory = {
            name: digest(jar.read(name)) for name in names
        }
    return inventory


def prepare(root):
    checkout = pathlib.Path(__file__).resolve().parents[2]
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout,
                                       text=True, timeout=10).strip()
    source_archive = subprocess.check_output(
        ["git", "archive", "--format=tar", revision, "zooglass"], cwd=checkout, timeout=15
    )
    root.mkdir()  # Refuse reuse of preparation and evidence directories.
    with tarfile.open(fileobj=io.BytesIO(source_archive)) as archive:
        archive.extractall(root, filter="data")
    source = root / "zooglass"
    rule = source / SOURCE_FILE
    original = rule.read_bytes()
    if original.count(BEFORE) != 1:
        raise ValueError("Clock mutation target changed; inspect before preparing")
    mutant = original.replace(BEFORE, AFTER)
    for name, payload in [("clock-original.java", original), ("clock-mutant.java", mutant)]:
        (root / name).write_bytes(payload)

    repository = root / "maven-repository"
    commands = [maven(["-DskipTests", "install"], source, repository)]
    host = source / "simulation-host"
    package = ["-f", "simulation-host/pom.xml", "-DskipTests", "clean", "package"]
    commands.append(maven(package, source, repository))
    built = host / "target/zooglass-simulation.jar"
    normal_jar = root / "normal.jar"
    shutil.copyfile(built, normal_jar)

    rule.write_bytes(mutant)
    commands.append(maven(package, source, repository))
    mutant_jar = root / "mutant.jar"
    shutil.copyfile(built, mutant_jar)

    normal_entries = jar_inventory(normal_jar)
    mutant_entries = jar_inventory(mutant_jar)
    if normal_entries.keys() != mutant_entries.keys():
        raise ValueError("Host artifact layout differs between builds")
    changed = sorted(name for name in normal_entries if normal_entries[name] != mutant_entries[name])
    # Maven stamps the build metadata. All other files except the clock must match.
    ignored = "META-INF/maven/io.zooglass/zooglass-simulation/pom.properties"
    if set(changed).difference({ignored}) != {CLASS_FILE}:
        raise ValueError(f"Unexpected host content changes: {changed}")
    runtime_entries = [name for name in normal_entries if name.startswith("BOOT-INF/lib/zooglass-")
                       and name.endswith("-runtime.jar")]
    runtime_hash = file_digest(source / "target/zooglass-runtime.jar")
    if len(runtime_entries) != 1 or normal_entries[runtime_entries[0]] != runtime_hash:
        raise ValueError("Prepared hosts must embed the newly built production runtime")

    manifest = {
        "format": "timeline-generation-clock-preparation/v1",
        "revision": revision,
        "sourceArchiveSha256": digest(source_archive),
        "recipeSha256": file_digest(pathlib.Path(__file__)),
        "java": subprocess.check_output(["java", "-version"], stderr=subprocess.STDOUT,
                                        text=True, timeout=10).strip(),
        "commands": commands,
        "mutation": {
            "file": SOURCE_FILE, "before": BEFORE.decode(), "after": AFTER.decode(),
            "originalSha256": digest(original), "mutatedSha256": digest(mutant),
            "class": CLASS_FILE,
            "originalClassSha256": normal_entries[CLASS_FILE],
            "mutatedClassSha256": mutant_entries[CLASS_FILE],
        },
        "runtime": {"entry": runtime_entries[0], "sha256": runtime_hash},
        "artifacts": {"normal": file_digest(normal_jar), "mutant": file_digest(mutant_jar)},
        "changedEntries": changed,
    }
    (root / "preparation.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Prepared {normal_jar} and {mutant_jar}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 scripts/prepare-generation-clock-mutation.py NEW_DIRECTORY")
    prepare(pathlib.Path(sys.argv[1]).resolve())
