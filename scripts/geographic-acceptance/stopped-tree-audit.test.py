"""Small synthetic fixtures; these do not substitute for WabiDB replay."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("stopped-tree-audit.py")
spec = importlib.util.spec_from_file_location("stopped_tree_audit", SCRIPT)
audit = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = audit
spec.loader.exec_module(audit)


class AuditTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wabi-stopped-audit-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.left, self.right = self.root / "left", self.root / "right"
        self.snapshot = {"watermark": 3, "indexes": [["users", [
            {"key": "02", "value": "ab"}, {"key": "01", "value": "cd"}]] ]}
        for tree in (self.left, self.right):
            (tree / "wabidb/projections").mkdir(parents=True)
            (tree / "uploads/empty").mkdir(parents=True)
            (tree / "unknown/empty").mkdir(parents=True)
            (tree / "wabidb/root_key").write_text("af" * 32)
            (tree / "jwt_secret").write_text("fixture-secret-not-for-output")
            (tree / "unknown/record").write_text("private-fixture-content")
            (tree / "uploads/file").write_bytes(b"fixture-file")
            (tree / audit.SNAPSHOT).write_text(json.dumps(self.snapshot))

    def run_audit(self, **options):
        return audit.compare(self.left, self.left / "uploads", self.right,
                             self.right / "uploads", **options)

    def refuses(self, reason, **options):
        with self.assertRaisesRegex(audit.Refused, "^" + reason + "$"):
            self.run_audit(**options)

    def test_whole_tree_includes_unknown_files_and_empty_directories(self):
        receipt = self.run_audit()
        self.assertEqual(receipt["result"], "PASS")
        self.assertFalse(receipt["fullInstanceReady"])
        self.assertFalse(receipt["engineReplayTested"])
        self.assertEqual(receipt["projection"]["entries"], 2)
        (self.right / "unknown/record").write_text("different")
        self.assertEqual(self.run_audit()["changedEntries"], 1)
        (self.right / "unknown/empty").rmdir()
        self.assertEqual(self.run_audit()["leftOnlyEntries"], 1)
        text = json.dumps(self.run_audit())
        for private in (str(self.root), "jwt_secret", "fixture-secret", "private-fixture", "unknown/record"):
            self.assertNotIn(private, text)

    def test_only_exact_runtime_files_excluded_and_lock_inode_preserved(self):
        self.run_audit()
        lock = self.left / "wabidb/.lock"
        inode = lock.stat().st_ino
        lock.write_text("diagnostic-pid")
        (self.right / "tailcat").mkdir()
        (self.left / "tailcat").mkdir()
        (self.right / "tailcat/addr.txt").write_text("local-address")
        self.assertEqual(self.run_audit()["result"], "PASS")
        self.assertEqual(lock.stat().st_ino, inode)
        self.assertEqual(lock.read_text(), "diagnostic-pid")
        (self.left / "unknown/.lock").write_text("this-is-state")
        self.assertEqual(self.run_audit()["leftOnlyEntries"], 1)

    def test_actual_advisory_writer_lock_refuses_and_releases(self):
        lock = self.left / "wabidb/.lock"
        with lock.open("w+") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.refuses("WRITER_ACTIVE")
        self.assertEqual(self.run_audit()["result"], "PASS")
        with lock.open("r+") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_killed_audit_releases_kernel_lock_without_inode_removal(self):
        self.run_audit()
        lock = self.left / "wabidb/.lock"
        inode = lock.stat().st_ino
        program = '''
import importlib.util,sys,time
spec=importlib.util.spec_from_file_location("audit_child",sys.argv[1])
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
def hold(self,count):
    print("locked",flush=True);time.sleep(30)
m.Budget.bytes=hold
m.compare(*sys.argv[2:])
'''
        child = subprocess.Popen([sys.executable, "-c", program, str(SCRIPT), str(self.left),
                                  str(self.left / "uploads"), str(self.right), str(self.right / "uploads")],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(5), "audit child reached its locked read")
            self.assertEqual(child.stdout.readline().strip(), "locked")
            with lock.open("r+") as handle:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            child.kill()
            child.wait(timeout=5)
            with lock.open("r+") as handle:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(lock.stat().st_ino, inode)
        finally:
            if child.poll() is None:
                child.kill(); child.wait(timeout=5)
            child.stdout.close(); child.stderr.close()

    def test_live_restore_guards_required_validated_and_never_removed(self):
        self.refuses("MISSING_INACTIVE_GUARD", inactive=True)
        for relative, content in audit.LIVE_GUARDS.items():
            (self.right / relative).write_bytes(content)
        self.assertEqual(self.run_audit(inactive=True)["result"], "PASS")
        self.assertEqual(self.run_audit()["rightOnlyEntries"], 2)
        (self.right / "wabidb/writer-fenced-v1").write_bytes(b"wrong")
        self.refuses("INVALID_INACTIVE_GUARD", inactive=True)
        self.assertTrue((self.right / "wabidb/live-checkpoint-v1").exists())

    def test_symlink_unsupported_file_and_hardlink_refused(self):
        path = self.right / "unknown/link"
        path.symlink_to(self.left / "jwt_secret")
        self.refuses("UNSUPPORTED_ENTRY")
        path.unlink()
        os.mkfifo(path)
        self.refuses("UNSUPPORTED_ENTRY")
        path.unlink()
        os.link(self.left / "jwt_secret", path)
        self.refuses("UNSUPPORTED_ENTRY")

    def test_legacy_root_lock_and_symlink_lock_refused(self):
        (self.left / ".lock").write_text("old-pid")
        self.refuses("LEGACY_LOCK")
        (self.left / ".lock").unlink()
        (self.left / "wabidb/.lock").symlink_to(self.left / "jwt_secret")
        with self.assertRaises(OSError):
            self.run_audit()

    def test_overlap_and_symlink_root_refused(self):
        with self.assertRaisesRegex(audit.Refused, "OVERLAPPING_ROOTS"):
            audit.compare(self.left, self.left / "uploads", self.left, self.left / "uploads")
        link = self.root / "link"
        link.symlink_to(self.left, target_is_directory=True)
        with self.assertRaisesRegex(audit.Refused, "UNSAFE_ROOT"):
            audit.compare(link, link / "uploads", self.right, self.right / "uploads")

    def test_external_and_embedded_upload_mapping(self):
        external = self.root / "external"
        shutil.move(self.right / "uploads", external)
        result = audit.compare(self.left, self.left / "uploads", self.right, external)
        self.assertEqual(result["result"], "PASS")
        (external / "empty").rmdir()
        self.assertEqual(audit.compare(self.left, self.left / "uploads", self.right,
                                      external)["leftOnlyEntries"], 1)

    def test_limits_and_deadline_release_locks(self):
        for limits, reason in [(audit.Limits(entries=1), "INVENTORY_LIMIT"),
                               (audit.Limits(file_bytes=1), "BYTE_LIMIT"),
                               (audit.Limits(path_bytes=1), "INVENTORY_LIMIT"),
                               (audit.Limits(entries=0), "INVALID_LIMIT")]:
            self.refuses(reason, limits=limits)
        with patch.object(audit.time, "monotonic", side_effect=[0, 121]):
            self.refuses("DEADLINE")
        self.assertEqual(self.run_audit()["result"], "PASS")

    def test_projection_strict_schema_hex_and_duplicates(self):
        malformed = [b'{"watermark":1,"watermark":2,"indexes":[]}',
                     b'{"watermark":true,"indexes":[]}',
                     b'{"watermark":1,"indexes":[],"unknown":0}']
        for payload in malformed:
            with self.assertRaisesRegex(audit.Refused, "INVALID_PROJECTION"):
                audit.projection(payload)
        for records in [[{"key": "a", "value": "00"}], [{"key": "01", "value": "zz"}],
                        [{"key": "ab", "value": "00"}, {"key": "AB", "value": "01"}]]:
            self.snapshot["indexes"][0][1] = records
            (self.left / audit.SNAPSHOT).write_text(json.dumps(self.snapshot))
            self.refuses("INVALID_PROJECTION")
        (self.left / audit.SNAPSHOT).write_bytes(b" " * (audit.JSON_LIMIT + 1))
        self.refuses("PROJECTION_LIMIT")

    def test_order_normalization_does_not_hide_raw_file_difference(self):
        other = {"watermark": 3, "indexes": [["users", list(reversed(self.snapshot["indexes"][0][1]))]]}
        self.assertEqual(audit.projection(json.dumps(other)),
                         audit.projection(json.dumps(self.snapshot)))
        (self.right / audit.SNAPSHOT).write_text(json.dumps(other))
        receipt = self.run_audit()
        self.assertEqual(receipt["result"], "FAIL")
        self.assertTrue(receipt["projectionMatch"])
        self.assertEqual(receipt["changedEntries"], 1)

    def test_missing_keys_or_snapshot_and_invalid_key_refused(self):
        (self.right / "jwt_secret").unlink()
        (self.right / "jwt_secret").mkdir()
        self.refuses("MISSING_CORE_MATERIAL")
        (self.right / "jwt_secret").rmdir()
        (self.right / "jwt_secret").write_text("secret")
        (self.right / "wabidb/root_key").write_text("invalid")
        self.refuses("MISSING_CORE_MATERIAL")

    def test_mutating_file_detected_and_cli_failure_redacted(self):
        original = os.read
        mutated = False
        def mutate(fd, count):
            nonlocal mutated
            chunk = original(fd, count)
            if (chunk and not mutated
                    and os.fstat(fd).st_ino == (self.left / "unknown/record").stat().st_ino):
                mutated = True
                with (self.left / "unknown/record").open("a") as handle:
                    handle.write("changed-during-read")
            return chunk
        with patch.object(audit.os, "read", side_effect=mutate):
            self.refuses("TREE_CHANGED")
        output = subprocess.run([sys.executable, str(SCRIPT), "--left-data", str(self.root / "missing-secret-path"),
                                 "--left-uploads", str(self.left / "uploads"), "--right-data", str(self.right),
                                 "--right-uploads", str(self.right / "uploads")],
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(output.returncode, 1)
        self.assertEqual(output.stderr, "")
        self.assertEqual(json.loads(output.stdout)["result"], "REFUSED")
        self.assertNotIn(str(self.root), output.stdout)


if __name__ == "__main__":
    unittest.main()
