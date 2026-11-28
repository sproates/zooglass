#!/usr/bin/env python3
"""Prepare or verify the two non-serving, capture-only HA mutation controls."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile

SERVICE = Path(__file__).resolve().parents[1]
TARGET = SERVICE / "target"
OUTPUT = TARGET / "ha-fence-controls"
PACKAGE = Path("io/zooglass/runtime")
AUTHORITY = PACKAGE / "PostgresAuthority.class"
SOURCE = SERVICE / "src/main/java" / PACKAGE / "PostgresAuthority.java"
ORACLES = ("PostgresFenceControlsIT", "PostgresFenceScenario")
# These are the complete project test-helper closure executed by the control children.
ORACLE_SOURCES = (*ORACLES, "PostgresTestDatabase", "HaStaticProfileTests")
RUNTIME = TARGET / "zooglass-runtime.jar"
SERVICE_JAR = TARGET / "zooglass.jar"
ORIGINAL = """    long capture(long revision) throws SQLException {
        var row = require("active");
        verifyRevision(row, revision);
        return revision;
    }"""
# These substitutions apply only to capture(). Mutations, activation, renewal,
# probe() and the separate handoff admission still use the full authority checks.
VARIANTS = {
    "capture-owner": ORIGINAL.replace('var row = require("active");',
        'var row = lock();\n        if (!row.leased() || !"active".equals(row.role)) throw new SQLException("Runtime authority lost");'),
    "capture-revision": ORIGINAL.replace("        verifyRevision(row, revision);\n", ""),
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inputs():
    source = SOURCE.read_text()
    if source.count(ORIGINAL) != 1:
        raise ValueError("Expected exactly one reviewed capture method; review the mutation definitions")
    with zipfile.ZipFile(RUNTIME) as runtime, zipfile.ZipFile(SERVICE_JAR) as service:
        original = runtime.read(AUTHORITY.as_posix())
        if service.read("BOOT-INF/classes/" + AUTHORITY.as_posix()) != original:
            raise ValueError("Prepared service and runtime contain different authority classes")
    tests = [path for name in ORACLE_SOURCES for path in sorted((TARGET / "test-classes" / PACKAGE).glob(name + "*.class"))]
    if not all((TARGET / "test-classes" / PACKAGE / (name + ".class")).is_file() for name in ORACLE_SOURCES):
        raise ValueError("Prepare Java and its test classes explicitly before the HA controls")
    return source, {
        "format": 2,
        "preparerSha256": file_hash(Path(__file__)),
        "sourceSha256": file_hash(SOURCE),
        "serviceJarSha256": file_hash(SERVICE_JAR),
        "runtimeJarSha256": file_hash(RUNTIME),
        "authoritySha256": digest(original),
        "oracleSources": {name: file_hash(SERVICE / "src/test/java" / PACKAGE / (name + ".java")) for name in ORACLE_SOURCES},
        "oracleClasses": {path.name: file_hash(path) for path in tests},
    }


def prepare(test_classpath):
    source, manifest = inputs()
    javac = str(Path(os.environ["JAVA_HOME"]) / "bin/javac") if os.environ.get("JAVA_HOME") else "javac"
    controls = {}
    # Publish the manifest last. An interrupted preparation cannot authorise a mixed set of classes.
    with tempfile.TemporaryDirectory(prefix="ha-control-compile-", dir=TARGET) as work:
        workspace = Path(work)
        reference = workspace / "oracle-reference"
        reference.mkdir()
        # Deliberately omit target/test-classes: a newly introduced project helper
        # must be added to the reviewed closure, not silently read from stale output.
        subprocess.run([javac, "--release", "25", "-g", "-parameters", "-proc:none",
                        "-classpath", os.pathsep.join((str(RUNTIME), test_classpath)),
                        "-d", str(reference),
                        *(str(SERVICE / "src/test/java" / PACKAGE / (name + ".java")) for name in ORACLE_SOURCES)],
                       check=True, timeout=45)
        compiled = {path.name: file_hash(path) for path in (reference / PACKAGE).glob("*.class")}
        if compiled != manifest["oracleClasses"]:
            raise ValueError("Prepared oracle/helper classes differ from current source; explicitly prepare Java tests with the same JDK first")
        for name, replacement in {"production": ORIGINAL, **VARIANTS}.items():
            text = source.replace(ORIGINAL, replacement)
            variant = workspace / name
            java = variant / "src" / PACKAGE / SOURCE.name
            java.parent.mkdir(parents=True)
            java.write_text(text)
            classes = variant / "classes"
            classes.mkdir()
            subprocess.run([javac, "--release", "25", "-g", "-parameters", "-proc:none",
                            "-classpath", str(RUNTIME), "-d", str(classes), str(java)], check=True, timeout=45)
            compiled = classes / AUTHORITY
            if name == "production":
                if file_hash(compiled) != manifest["authoritySha256"]:
                    raise ValueError("Recompiled reference class differs from prepared runtime. Use the same JDK 25 and prepare Java first.")
                continue
            destination = OUTPUT / name / AUTHORITY
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(compiled, destination)
            controls[name] = {"sourceSha256": digest(text.encode()), "classSha256": file_hash(compiled)}
        if len({manifest["authoritySha256"], *(entry["classSha256"] for entry in controls.values())}) != 3:
            raise ValueError("Expected three distinct authority classes")
    manifest["controls"] = controls
    temp = OUTPUT / "manifest.pending"
    temp.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    temp.replace(OUTPUT / "manifest.json")
    verify()


def verify():
    source, expected = inputs()
    actual = json.loads((OUTPUT / "manifest.json").read_text())
    controls = actual.pop("controls")
    if actual != expected or set(controls) != set(VARIANTS):
        raise ValueError("Stale control preparation; prepare against the current source, tests and JARs")
    for name, replacement in VARIANTS.items():
        folder = OUTPUT / name
        if [p.relative_to(folder) for p in folder.rglob("*") if p.is_file()] != [AUTHORITY]:
            raise ValueError("Unexpected class in prepared control directory")
        if controls[name] != {"sourceSha256": digest(source.replace(ORIGINAL, replacement).encode()),
                              "classSha256": file_hash(folder / AUTHORITY)}:
            raise ValueError("Prepared control or reviewed transformation changed")
    if len({expected["authoritySha256"], *(entry["classSha256"] for entry in controls.values())}) != 3:
        raise ValueError("Controls must be distinct from the production capture and each other")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="Check existing preparation only; never compile")
    parser.add_argument("--test-classpath", type=Path,
                        help="File containing the Maven test dependency classpath (JARs only), required for preparation")
    args = parser.parse_args()
    try:
        if args.verify:
            if args.test_classpath:
                parser.error("--test-classpath is for explicit preparation only")
            verify()
        else:
            if not args.test_classpath:
                parser.error("Preparation requires --test-classpath FILE; create it with Maven dependency:build-classpath -Dmdep.includeScope=test -Dmdep.outputFile=target/ha-test-classpath.txt")
            entries = [entry for entry in args.test_classpath.read_text().strip().split(os.pathsep) if entry]
            if not entries or any(not Path(entry).is_file() or Path(entry).suffix != ".jar" for entry in entries):
                raise ValueError("Test dependency classpath must contain existing JARs only")
            prepare(os.pathsep.join(entries))
        print("Verified two capture-only control classes and the prepared runtime; no service JAR was modified.")
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        sys.exit(f"HA control preparation failed: {error}")
