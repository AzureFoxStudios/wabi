"""No network/live data: private ownership, fixed-command and disposal guards."""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("checkpoint_host", Path(__file__).with_name("checkpoint-field-host.py"))
host_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host_module)


class HostGuards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wabi-checkpoint-field-", dir="/tmp")
        self.root = Path(self.temp.name)
        os.chmod(self.root, 0o700)
        self.owner = "b3" * 32
        # A known ELF used only to demonstrate that fixed-argument execution
        # without the Rust result marker can never be accepted as success.
        shutil.copyfile("/bin/true", self.root / "probe.bin")
        os.chmod(self.root / "probe.bin", 0o700)
        self.sha = hashlib.sha256((self.root / "probe.bin").read_bytes()).hexdigest()
        self.fixture = {"schemaVersion": 1, "purpose": host_module.PURPOSE, "owner": self.owner,
                        "binding": {"nodeId": 2}, "peers": {}, "bindAddress": "127.0.0.1:0",
                        "sourceNode": "test-only", "manifestSha256": "c4" * 32, "lifetimeSeconds": 30}
        self.write("fixture.json", self.fixture)
        self.write("bootstrap.json", {})
        self.write("recovery.key", bytes(32))
        self.host = None

    def tearDown(self):
        if self.host is not None:
            self.host.close()
        self.temp.cleanup()

    def write(self, name, value):
        path = self.root / name
        path.write_bytes(value if isinstance(value, bytes) else json.dumps(value).encode())
        os.chmod(path, 0o600)

    def claim(self):
        self.host = host_module.Host(str(self.root), self.owner, self.sha, 2, claim=True)
        return self.host

    def test_claim_and_readback_exact_private_root(self):
        self.claim().check()
        self.host.close()
        self.host = host_module.Host(str(self.root), self.owner, self.sha, 2)
        self.host.check()

    def test_changed_owner_refuses_before_guard_files(self):
        with self.assertRaises(host_module.guard.Refused):
            host_module.Host(str(self.root), "d5" * 32, self.sha, 2, claim=True)
        self.assertFalse((self.root / host_module.LOCK).exists())

    def test_boolean_schema_is_not_integer(self):
        self.fixture["schemaVersion"] = True
        self.write("fixture.json", self.fixture)
        with self.assertRaises(host_module.guard.Refused):
            self.claim()

    def test_duplicate_unknown_and_public_config_refused(self):
        for data in [b'{"schemaVersion":1,"schemaVersion":1}', b'{}']:
            self.write("fixture.json", data)
            with self.assertRaises(host_module.guard.Refused):
                self.claim()
        self.write("fixture.json", self.fixture)
        os.chmod(self.root / "fixture.json", 0o644)
        with self.assertRaises(host_module.guard.Refused):
            self.claim()

    def test_substituted_or_hardlinked_artifact_refused(self):
        outside = self.root / "extra"
        os.link(self.root / "probe.bin", outside)
        with self.assertRaises(host_module.guard.Refused):
            self.claim()
        outside.unlink()
        self.claim()
        (self.root / "probe.bin").unlink()
        shutil.copyfile("/bin/true", self.root / "probe.bin")
        os.chmod(self.root / "probe.bin", 0o700)
        with self.assertRaises(host_module.guard.Refused):
            self.host.check()

    def test_config_change_and_second_active_owner_refuse(self):
        self.claim()
        other = host_module.Host(str(self.root), self.owner, self.sha, 2)
        try:
            with self.assertRaises(host_module.guard.Refused):
                other.exclusive()
        finally:
            other.close()
        self.fixture["lifetimeSeconds"] = 31
        self.write("fixture.json", self.fixture)
        with self.assertRaises(host_module.guard.Refused):
            self.host.check()

    def test_fixed_command_cannot_fabricate_worker_receipt(self):
        self.claim()
        with self.assertRaises(host_module.guard.Refused):
            self.host.run("receipt", None)
        self.assertIsNotNone(self.host.record["child"])
        self.assertIsNotNone(self.host.child.returncode)
        self.host.inactive()

    def test_unknown_action_and_self_target_refuse_without_child(self):
        self.claim()
        for action, target in [("shell", None), ("push", 2), ("receipt", 1), ("pull", True)]:
            with self.assertRaises(host_module.guard.Refused):
                self.host.run(action, target)
        self.assertIsNone(self.host.child)

    def test_final_disposal_only_owned_root(self):
        self.claim()
        result = self.host.cleanup()
        self.assertTrue(result["ownedRootRemoved"])
        self.assertFalse(self.root.exists())

    def test_live_material_lock_blocks_loss_and_cleanup(self):
        self.claim()
        material = self.root / "material"
        material.mkdir(mode=0o700)
        self.write("material/.lock", b"")
        with open(material / ".lock", "rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.host.lose_copy()
            with self.assertRaises(BlockingIOError):
                self.host.cleanup()
        self.assertTrue((material / ".lock").exists())

    def test_worker_marker_accepts_only_exact_rust_harness_prefix(self):
        for prefix in [b"", b"test checkpoint_ciphertext_worker ... "]:
            for representation in [bytes, bytearray]:
                self.assertEqual(host_module.result_markers(representation(prefix + b'WABI_CHECKPOINT_RESULT_V1 {}\n')), [b'{}'])
        with self.assertRaises(host_module.guard.Refused):
            host_module.result_markers(b'wrong-test WABI_CHECKPOINT_RESULT_V1 {}\n')

    def test_listener_ready_waits_for_complete_line_and_refuses_duplicate_or_changed_fields(self):
        payload = {"nodeId": 2, "manifestSha256": "c4" * 32}
        line = b'test checkpoint_ciphertext_worker ... WABI_CHECKPOINT_LISTEN_V1 ' + json.dumps(payload).encode() + b'\n'
        for split in range(len(line)):
            self.assertIsNone(host_module.listener_ready(line[:split], 2, "c4" * 32))
        ready = host_module.listener_ready(line + b'partial later output', 2, "c4" * 32)
        self.assertTrue(ready["listening"])
        with self.assertRaises(host_module.guard.Refused):
            host_module.listener_ready(line + line, 2, "c4" * 32)
        for changed in [dict(payload, nodeId=3), dict(payload, nodeId=True),
                        dict(payload, manifestSha256="d5" * 32), dict(payload, writerPermitted=True)]:
            with self.assertRaises(host_module.guard.Refused):
                host_module.listener_ready(b'WABI_CHECKPOINT_LISTEN_V1 ' + json.dumps(changed).encode() + b'\n', 2, "c4" * 32)
        with self.assertRaises(host_module.guard.Refused):
            host_module.listener_ready(b'WABI_CHECKPOINT_LISTEN_V1 {"nodeId":2,"nodeId":2,"manifestSha256":"' + b'c4'*32 + b'"}\n', 2, "c4" * 32)


if __name__ == "__main__":
    unittest.main()
