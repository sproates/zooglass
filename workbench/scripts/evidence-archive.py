"""Pack or verify a bounded, deterministic evidence archive without extracting it."""
import gzip
import hashlib
import io
import json
import pathlib
import sys
import tarfile

LIMIT = 256 * 1024 * 1024
FILE_LIMIT = 16 * 1024 * 1024
MAX_MEMBERS = 10000

def sha(data):
    return hashlib.sha256(data).hexdigest()

def safe_name(name):
    path = pathlib.PurePosixPath(name)
    return not path.is_absolute() and ".." not in path.parts and str(path) == name

def pack(output, sources):
    entries = {}
    total = 0
    for source in sources:
        if source.is_symlink() or not source.exists():
            raise ValueError("Sources must exist and cannot be symlinks")
        candidates = sorted(source.rglob("*")) if source.is_dir() else [source]
        for path in candidates:
            if path.is_symlink():
                raise ValueError("Evidence must not contain symlinks")
            if path.is_dir():
                continue
            name = str(path.relative_to(source.parent))
            if not path.is_file() or not safe_name(name) or name in entries or name == "inventory.json":
                raise ValueError("Invalid or duplicate evidence member: " + name)
            if path.stat().st_size > FILE_LIMIT:
                raise ValueError("Member exceeds byte limit")
            with path.open("rb") as raw:
                data = raw.read(FILE_LIMIT + 1)
            if len(data) > FILE_LIMIT:
                raise ValueError("Member exceeds byte limit")
            if len(entries) >= MAX_MEMBERS - 1:
                raise ValueError("Too many archive members")
            total += len(data)
            if total > LIMIT:
                raise ValueError("Archive exceeds byte limit")
            entries[name] = data
    if not entries:
        raise ValueError("No evidence files")
    index = {name: {"bytes": len(data), "sha256": sha(data)} for name, data in sorted(entries.items())}
    entries["inventory.json"] = (json.dumps(index, indent=2) + "\n").encode()
    if any(len(data) > FILE_LIMIT for data in entries.values()):
        raise ValueError("Member exceeds byte limit")
    if len(entries) > MAX_MEMBERS:
        raise ValueError("Too many archive members")
    container = io.BytesIO()
    with tarfile.open(fileobj=container, mode="w") as archive:
        for name, data in sorted(entries.items()):
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = 0o644
            archive.addfile(member, io.BytesIO(data))
            if container.tell() > LIMIT:
                raise ValueError("Decompressed container exceeds byte limit")
    if container.tell() > LIMIT:
        raise ValueError("Decompressed container exceeds byte limit")
    compressed = gzip.compress(container.getvalue(), mtime=0)
    if len(compressed) > LIMIT:
        raise ValueError("Compressed container exceeds byte limit")
    with output.open("xb") as raw:
        raw.write(compressed)

def verify(path):
    entries = {}
    total = 0
    # Read through gzip EOF to verify CRCs and all concatenated members before
    # tarfile can stop at its first end marker. Bound headers/PAX data as well.
    with path.open("rb") as raw:
        compressed_bytes = raw.read(LIMIT + 1)
    if len(compressed_bytes) > LIMIT:
        raise ValueError("Compressed container exceeds byte limit")
    with gzip.GzipFile(fileobj=io.BytesIO(compressed_bytes), mode="rb") as compressed:
        container = compressed.read(LIMIT + 1)
    if len(container) > LIMIT:
        raise ValueError("Decompressed container exceeds byte limit")
    with tarfile.open(fileobj=io.BytesIO(container), mode="r:") as archive:
        for member in archive:
            if not member.isfile() or not safe_name(member.name) or member.name in entries:
                raise ValueError("Unsafe or duplicate archive member")
            total += member.size
            if member.size > FILE_LIMIT or total > LIMIT:
                raise ValueError("Evidence byte limit")
            data = archive.extractfile(member).read()
            if len(data) != member.size:
                raise ValueError("Truncated member")
            entries[member.name] = data
            if len(entries) > MAX_MEMBERS:
                raise ValueError("Too many archive members")
        padding = container[archive.offset:]
        if len(padding) < 1024 or any(padding):
            raise ValueError("Trailing non-padding data or missing tar terminator")
    index = json.loads(entries.pop("inventory.json"))
    actual = {name: {"bytes": len(data), "sha256": sha(data)} for name, data in entries.items()}
    if actual != index:
        raise ValueError("Evidence inventory mismatch")
    print(json.dumps({"files": len(entries), "bytes": sum(map(len, entries.values())),
                      "archiveSha256": sha(compressed_bytes)}))

def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("pack", "verify"):
        raise SystemExit("Usage: evidence-archive.py pack NEW_ARCHIVE SOURCES... | verify ARCHIVE")
    output = pathlib.Path(sys.argv[2])
    if sys.argv[1] == "pack":
        if len(sys.argv) < 4:
            raise SystemExit("Supply evidence sources")
        pack(output, [pathlib.Path(p) for p in sys.argv[3:]])
    elif len(sys.argv) != 3:
        raise SystemExit("verify accepts one archive")
    verify(output)

if __name__ == "__main__":
    main()
