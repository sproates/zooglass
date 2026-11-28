#!/usr/bin/env python3
"""Explicitly prepare or verify the launch-only write and viewer barriers for the HA fixture."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

SERVICE = Path(__file__).resolve().parents[1]
TARGET = SERVICE / "target"
OUTPUT = TARGET / "ha-fault-agent"
SERVICE_JAR = TARGET / "zooglass.jar"
AGENT = OUTPUT / "ha-fault-agent.jar"
MANIFEST = OUTPUT / "manifest.json"
SUPPORT = SERVICE / "test-support/ha-fault-agent"
JAVA_SOURCES = tuple(SUPPORT / f"{name}.java" for name in ("InstrumentWriter", "InstrumentAuthority", "WriterAgent", "WriterBarrier"))
PACKAGE = "io/zooglass/testagent/"
TARGETS = {
    "HaDelivery": ("io/zooglass/delivery/HaDelivery", "InstrumentWriter",
                   "f5fd1b1eb89d62085bf7f122f853315a40c713386292ffda08c4e6953128e928"),
    "PostgresAuthority": ("io/zooglass/runtime/PostgresAuthority", "InstrumentAuthority",
                          "87a06868c1dd87479c004118231c0bc41191989563557173ab0eddb2e010cf34"),
}
IDENTITY = "barrier/identity.properties"
ENTRY = b"Manifest-Version: 1.0\r\nPremain-Class: io.zooglass.testagent.WriterAgent\r\n\r\n"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inputs():
    originals, targets = {}, {}
    with zipfile.ZipFile(SERVICE_JAR) as jar:
        for name, (target, editor, reviewed_sha) in TARGETS.items():
            source = SERVICE / "src/main/java" / (target + ".java")
            if file_hash(source) != reviewed_sha:
                raise ValueError(f"{name} source changed: review barrier sites before preparation")
            original = jar.read("BOOT-INF/classes/" + target + ".class")
            originals[name] = original
            targets[name] = {"class": target, "editor": editor, "sourceSha256": reviewed_sha,
                             "originalSha256": digest(original)}
    return originals, {
        "format": 3,
        "preparerSha256": file_hash(Path(__file__)),
        "serviceSha256": file_hash(SERVICE_JAR),
        "targets": targets,
        "sources": {path.name: file_hash(path) for path in JAVA_SOURCES},
    }


def properties(manifest):
    lines = [f"serviceSha256={manifest['serviceSha256']}"]
    for name, target in manifest["targets"].items():
        for key in ("originalSha256", "instrumentedSha256"):
            lines.append(f"{name}.{key}={target[key]}")
    return ("\n".join(lines) + "\n").encode()


def tool(name):
    return str(Path(os.environ["JAVA_HOME"]) / "bin" / name) if os.environ.get("JAVA_HOME") else name


def editor_classpath(work, classes):
    # The JDK stack-map generator needs the class hierarchy of the actual packaged writer,
    # including its Spring WebSocket types. Read these as resources without starting Spring.
    dependencies = work / "classpath"
    dependencies.mkdir()
    app = dependencies / "application.jar"
    cp = [str(classes), str(app)]
    with zipfile.ZipFile(SERVICE_JAR) as packaged, zipfile.ZipFile(app, "w") as app_classes:
        for entry in packaged.infolist():
            if entry.filename.startswith("BOOT-INF/classes/") and entry.filename.endswith(".class"):
                app_classes.writestr(entry.filename.removeprefix("BOOT-INF/classes/"), packaged.read(entry))
            elif entry.filename.startswith("BOOT-INF/lib/") and entry.filename.endswith(".jar"):
                # Use locally generated filenames rather than archive-supplied filesystem paths.
                library = dependencies / f"dependency-{len(cp)}.jar"
                library.write_bytes(packaged.read(entry))
                cp.append(str(library))
    return os.pathsep.join(cp)


def prepare():
    originals, manifest = inputs()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="compile-", dir=OUTPUT) as temporary:
        work = Path(temporary)
        classes = work / "classes"
        classes.mkdir()
        subprocess.run([tool("javac"), "--release", "25", "-g", "-d", str(classes), *map(str, JAVA_SOURCES)],
                       check=True, timeout=45)
        contents = {"META-INF/MANIFEST.MF": ENTRY}
        classpath = editor_classpath(work, classes)
        reference = work / "reference"
        reference.mkdir()
        sources = [SERVICE / "src/main/java" / (target + ".java")
                   for target, _, _ in TARGETS.values()]
        # A matching call shape is insufficient: the packaged implementation must be
        # the reviewed source, including its nested classes, before we instrument it.
        subprocess.run([tool("javac"), "--release", "25", "-g", "-parameters", "-proc:none",
                        "-classpath", classpath, "-d", str(reference), *map(str, sources)],
                       check=True, timeout=45)
        with zipfile.ZipFile(SERVICE_JAR) as packaged:
            for compiled in reference.rglob("*.class"):
                entry = "BOOT-INF/classes/" + compiled.relative_to(reference).as_posix()
                if compiled.read_bytes() != packaged.read(entry):
                    raise ValueError(f"Packaged class differs from reviewed source: {entry}; prepare Java with the same JDK first")
        for name, original in originals.items():
            target = manifest["targets"][name]
            plain, edited = work / f"{name}.class", work / f"{name}.instrumented"
            plain.write_bytes(original)
            subprocess.run([tool("java"), "-cp", classpath, "io.zooglass.testagent." + target["editor"],
                            str(plain), str(edited)], check=True, timeout=30)
            target["instrumentedSha256"] = file_hash(edited)
            if target["instrumentedSha256"] == target["originalSha256"]:
                raise ValueError(f"The editor did not change {name}")
            contents[f"barrier/{name}.instrumented"] = edited.read_bytes()
        contents[IDENTITY] = properties(manifest)
        for name in ("WriterAgent.class", "WriterBarrier.class"):
            contents[PACKAGE + name] = (classes / PACKAGE / name).read_bytes()
        staged = work / AGENT.name
        with zipfile.ZipFile(staged, "w") as jar:
            for name, data in contents.items():
                jar.writestr(zipfile.ZipInfo(name), data, compress_type=zipfile.ZIP_DEFLATED)
        manifest["agentSha256"] = file_hash(staged)
        staged.replace(AGENT)
        record = work / MANIFEST.name
        record.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        record.replace(MANIFEST)
    verify()


def verify():
    _, required = inputs()
    manifest = json.loads(MANIFEST.read_text())
    if (any(manifest.get(k) != v for k, v in required.items() if k != "targets")
            or any(any(manifest["targets"][name].get(k) != v for k, v in target.items())
                   for name, target in required["targets"].items())
            or manifest["agentSha256"] != file_hash(AGENT)):
        raise ValueError("Stale or changed fault agent: explicitly prepare it against this service JAR")
    members = {"META-INF/MANIFEST.MF", IDENTITY, PACKAGE + "WriterAgent.class", PACKAGE + "WriterBarrier.class"}
    members.update(f"barrier/{name}.instrumented" for name in TARGETS)
    with zipfile.ZipFile(AGENT) as jar:
        if sorted(jar.namelist()) != sorted(members) or jar.read("META-INF/MANIFEST.MF") != ENTRY:
            raise ValueError("Unexpected launch-only fault agent contents")
        if jar.read(IDENTITY) != properties(manifest):
            raise ValueError("Fault agent identity mismatch")
        for name, target in manifest["targets"].items():
            if (digest(jar.read(f"barrier/{name}.instrumented")) != target["instrumentedSha256"]
                    or target["originalSha256"] == target["instrumentedSha256"]):
                raise ValueError(f"Fault agent {name} identities do not match")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="Verify already-prepared evidence; never compile")
    args = parser.parse_args()
    try:
        (verify if args.verify else prepare)()
        print(f"Verified launch-only writer barrier: {AGENT}")
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.SubprocessError) as failure:
        sys.exit(f"HA fault agent preparation failed: {failure}")
