"""Focused checks for the standalone evidence pack/verify command."""
import io
import gzip
import json
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts/evidence-archive.py"

class EvidenceArchiveTest(unittest.TestCase):
    def invoke(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                              capture_output=True, text=True)

    def test_exact_bytes_determinism_and_exclusive_destination(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            source = root / "evidence"
            source.mkdir()
            (source / "trace.jsonl").write_bytes(b'{"exact":9007199254740993}\n')
            a, b = root / "a.tar.gz", root / "b.tar.gz"
            for output in [a, b]:
                result = self.invoke("pack", output, source)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout)["files"], 1)
            self.assertEqual(a.read_bytes(), b.read_bytes())
            self.assertNotEqual(self.invoke("pack", a, source).returncode, 0)
            self.assertEqual(self.invoke("verify", a).returncode, 0)

    def test_changed_bytes_and_unsafe_members_reject_without_extraction(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            for i, (name, link) in enumerate([("trace", False), ("../escape", False),
                                             ("link", True), ("trace", False)]):
                archive = root / f"{i}.tar.gz"
                with tarfile.open(archive, "w:gz") as target:
                    inventory = b'{"trace":{"bytes":1,"sha256":"incorrect"}}'
                    info = tarfile.TarInfo("inventory.json")
                    info.size = len(inventory)
                    target.addfile(info, io.BytesIO(inventory))
                    info = tarfile.TarInfo(name)
                    if link:
                        info.type = tarfile.SYMTYPE
                        info.linkname = "/outside"
                        target.addfile(info)
                    else:
                        info.size = 1
                        target.addfile(info, io.BytesIO(b"x"))
                        if i == 3:
                            target.addfile(info, io.BytesIO(b"x"))
                self.assertNotEqual(self.invoke("verify", archive).returncode, 0)

    def test_gzip_footer_and_appended_container_are_verified(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            source = root / "evidence"
            source.mkdir()
            (source / "run.json").write_text("{}")
            archive = root / "good.tar.gz"
            self.assertEqual(self.invoke("pack", archive, source).returncode, 0)
            damaged = bytearray(archive.read_bytes())
            damaged[-8] ^= 1
            bad = root / "bad-footer.tar.gz"
            bad.write_bytes(damaged)
            self.assertNotEqual(self.invoke("verify", bad).returncode, 0)
            extra = io.BytesIO()
            with tarfile.open(fileobj=extra, mode="w") as tar:
                member = tarfile.TarInfo("../unlisted")
                member.size = 1
                tar.addfile(member, io.BytesIO(b"x"))
            appended = root / "appended.tar.gz"
            appended.write_bytes(archive.read_bytes() + gzip.compress(extra.getvalue()))
            self.assertNotEqual(self.invoke("verify", appended).returncode, 0)

    def test_container_bound_precedes_tar_parsing(self):
        # Run the module with a reduced bound to exercise the same check cheaply.
        import runpy
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            source = root / "evidence"
            source.mkdir()
            (source / "run").write_text("x")
            archive = root / "archive.tar.gz"
            self.assertEqual(self.invoke("pack", archive, source).returncode, 0)
            with patch.object(sys, "argv", [str(SCRIPT), "verify", str(archive)]):
                module = runpy.run_path(str(SCRIPT))
            module["verify"].__globals__["LIMIT"] = 100
            with self.assertRaisesRegex(ValueError, "Decompressed container"):
                module["verify"](archive)

    def test_symlink_source_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            source = root / "source"
            source.mkdir()
            (source / "link").symlink_to("/outside")
            self.assertNotEqual(self.invoke("pack", root / "archive.tar.gz", source).returncode, 0)

if __name__ == "__main__":
    unittest.main()
