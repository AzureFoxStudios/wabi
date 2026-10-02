"""Synthetic Linux process tests only: no Noise, Raft, WabiDB or node keys."""
import ctypes
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("rpc-probe-supervisor.py")
spec = importlib.util.spec_from_file_location("rpc_supervisor", SCRIPT)
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
OWNER = "ab" * 32
CHILD = '''
import fcntl,os,signal,time
from pathlib import Path
root=Path(os.environ["WABI_RPC_FIXTURE_ROOT"])
lock=os.open(root/".lock",os.O_RDWR|os.O_CREAT,0o600)
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
os.write(lock,b"synthetic-lock-diagnostic")
signal.signal(signal.SIGTERM,signal.SIG_IGN)
fd=os.open(root/"ready",os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
os.close(fd)
time.sleep(30)
'''
HELPER = '''
import importlib.util,json,signal,sys
spec=importlib.util.spec_from_file_location("guard",sys.argv[1])
g=importlib.util.module_from_spec(spec);sys.modules[spec.name]=g;spec.loader.exec_module(g)
s=g.Session(sys.argv[2],sys.argv[3],sys.argv[4],1,claim=True,synthetic=True)
signal.signal(signal.SIGTERM,lambda *_:setattr(s,"interrupted",True))
try:
    result=s.run(0,lifetime=10,idle=5,allow_restart=sys.argv[6]=="yes",_worker_args=("-c",sys.argv[5]))
    print(json.dumps(result),flush=True)
finally:
    s.stop();s.close()
'''


@unittest.skipUnless(sys.platform == "linux" and hasattr(os, "pidfd_open")
                     and hasattr(signal, "pidfd_send_signal"), "Linux pidfd required")
class SupervisorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wabi-rpc-supervisor-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "node"
        self.root.mkdir(mode=0o700)
        self.artifact = self.root / guard.ARTIFACT
        shutil.copyfile(os.path.realpath(sys.executable), self.artifact)
        self.artifact.chmod(0o700)
        self.sha = hashlib.sha256(self.artifact.read_bytes()).hexdigest()

    def session(self):
        result = guard.Session(str(self.root), OWNER, self.sha, 1, claim=True, synthetic=True)
        self.addCleanup(result.close)
        self.addCleanup(result.stop)
        return result

    def adopted(self, **changes):
        result = guard.Session(str(self.root), changes.get("owner", OWNER), self.sha, 1)
        self.addCleanup(result.close)
        return result

    def pipe(self):
        reader, writer = os.pipe()
        self.addCleanup(lambda: os.close(reader))
        return reader, writer

    def wait_ready(self):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not (self.root / "ready").exists():
            time.sleep(0.01)
        self.assertTrue((self.root / "ready").exists(), "synthetic child reached its lock")

    def helper(self, reader, *, allow_restart=False):
        child = subprocess.Popen([sys.executable, "-c", HELPER, str(SCRIPT), str(self.root),
                                  OWNER, self.sha, CHILD, "yes" if allow_restart else "no"], stdin=reader,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env={"PYTHONDONTWRITEBYTECODE": "1"})
        self.addCleanup(self.reap, child)
        return child

    @staticmethod
    def reap(child):
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
        if child.stdout:
            child.stdout.close()
        if child.stderr:
            child.stderr.close()

    def test_normal_worker_exit_is_reaped_and_exact_root_removed(self):
        session = self.session()
        reader, writer = self.pipe()
        try:
            receipt = session.run(reader, lifetime=1, idle=1, _worker_args=("-c", "pass"))
        finally:
            os.close(writer)
        self.assertEqual(receipt["endReason"], "worker_exit")
        self.assertIsNotNone(session.child.returncode)
        self.assertFalse(self.root.exists())
        self.assertFalse(receipt["encryptedRpcTested"])
        self.assertFalse(receipt["automaticWabiRecoveryTested"])
        text = json.dumps(receipt)
        for private in [str(self.root), OWNER, ".lock", "ready", "synthetic-lock-diagnostic"]:
            self.assertNotIn(private, text)

    def test_sigkill_and_live_restart_preserve_exact_store_and_lock(self):
        session = self.session()
        reader, writer = self.pipe()
        child_code = '''
import fcntl,os,time
from pathlib import Path
root=Path(os.environ["WABI_RPC_FIXTURE_ROOT"])
lock=os.open(root/".lock",os.O_RDWR|os.O_CREAT,0o600)
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
fd=os.open(root/"durable-fixture",os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
os.write(fd,b"x");os.fsync(fd);os.close(fd)
time.sleep(30)
'''
        errors = []
        observed = []
        def controller():
            try:
                for count in (1, 2, 3):
                    deadline = time.monotonic() + 4
                    while time.monotonic() < deadline:
                        path = self.root / "durable-fixture"
                        if path.exists() and path.read_bytes() == b"x" * count:
                            break
                        time.sleep(0.01)
                    self.assertEqual(path.read_bytes(), b"x" * count)
                    observed.append(((self.root / ".lock").stat().st_ino, path.stat().st_ino))
                    current = session.child
                    if count == 1:
                        current.kill()  # Actual process loss, not graceful restart.
                        deadline = time.monotonic() + 3
                        while current.poll() is None and time.monotonic() < deadline:
                            time.sleep(0.01)
                        self.assertEqual(current.returncode, -signal.SIGKILL)
                        self.assertTrue(self.root.exists())
                        self.assertEqual(path.read_bytes(), b"x")
                    if count < 3:
                        os.write(writer, b"keepalive\nrestart\n")
                        deadline = time.monotonic() + 3
                        while session.child is current and time.monotonic() < deadline:
                            time.sleep(0.01)
                        self.assertIsNotNone(current.returncode)
                        self.assertIsNone(guard.process_identity(current.pid))
                    else:
                        os.write(writer, b"stop\n")
            except BaseException as error:
                errors.append(error)
            finally:
                os.close(writer)
        thread = threading.Thread(target=controller)
        thread.start()
        try:
            receipt = session.run(reader, lifetime=10, idle=5, allow_restart=True,
                                  _worker_args=("-c", child_code))
        finally:
            thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        if errors:
            raise errors[0]
        self.assertEqual(len(observed), 3)
        self.assertEqual(len(set(observed)), 1, "same durable file and advisory lock after both restarts")
        self.assertEqual(receipt["workerRestarts"], 2)
        self.assertTrue(receipt["restartMode"])
        self.assertEqual(receipt["endReason"], "controller_stop")
        self.assertTrue(receipt["cleanupComplete"])
        self.assertFalse(self.root.exists())

    def test_dead_worker_restart_mode_still_expires_and_cleans(self):
        session = self.session()
        reader, writer = self.pipe()
        try:
            receipt = session.run(reader, lifetime=1, idle=0.2, allow_restart=True,
                                  _worker_args=("-c", "pass"))
        finally:
            os.close(writer)
        self.assertEqual(receipt["endReason"], "controller_timeout")
        self.assertEqual(receipt["workerRestarts"], 0)
        self.assertIsNotNone(session.child.returncode)
        self.assertFalse(self.root.exists())

    def test_restart_mode_keepalives_cannot_renew_absolute_lifetime(self):
        session = self.session()
        reader, writer = self.pipe()
        done = threading.Event()
        def controller():
            try:
                while not done.wait(0.02):
                    os.write(writer, b"keepalive\n")
            finally:
                os.close(writer)
        thread = threading.Thread(target=controller)
        thread.start()
        try:
            receipt = session.run(reader, lifetime=0.4, idle=0.2, allow_restart=True,
                                  _worker_args=("-c", "pass"))
        finally:
            done.set()
            thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(receipt["endReason"], "lifetime")
        self.assertFalse(self.root.exists())

    def test_restart_requires_opt_in_and_preserves_guard_after_refusal(self):
        session = self.session()
        reader, writer = self.pipe()
        try:
            os.write(writer, b"restart\n")
            with self.assertRaisesRegex(guard.Refused, "RESTART_REFUSED"):
                session.run(reader, lifetime=2, idle=2, _worker_args=("-c", "import time;time.sleep(30)"))
        finally:
            os.close(writer)
        self.assertIsNotNone(session.child.returncode)
        self.assertTrue(self.root.exists())
        session.cleanup()
        self.assertFalse(self.root.exists())

    def test_restart_requests_do_not_renew_idle_controller_lease(self):
        session = self.session()
        reader, writer = self.pipe()
        finished = threading.Event()
        def controller():
            try:
                # Launch several real replacements without keepalives. Their
                # requests cannot extend the original controller idle lease.
                for _ in range(3):
                    if finished.wait(0.05):
                        break
                    os.write(writer, b"restart\n")
                finished.wait(2)
            finally:
                os.close(writer)
        thread = threading.Thread(target=controller)
        thread.start()
        try:
            receipt = session.run(reader, lifetime=2, idle=0.4, allow_restart=True,
                                  _worker_args=("-c", "pass"))
        finally:
            finished.set()
            thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(receipt["endReason"], "controller_timeout")
        self.assertEqual(receipt["workerRestarts"], 3)
        self.assertFalse(self.root.exists())

    def test_restart_count_is_bounded_without_releasing_original_lock(self):
        session = self.session()
        inode = (self.root / guard.LOCK).stat().st_ino
        reader, writer = self.pipe()
        launches = []
        original = session.start
        def track(**kwargs):
            original(**kwargs)
            launches.append(session.child)
            self.assertEqual((self.root / guard.LOCK).stat().st_ino, inode)
            with self.assertRaisesRegex(guard.Refused, "SUPERVISOR_ACTIVE"):
                guard.Session(str(self.root), OWNER, self.sha, 1)
        try:
            os.write(writer, b"restart\n" * (guard.MAX_RESTARTS + 1))
            with patch.object(session, "start", side_effect=track):
                with self.assertRaisesRegex(guard.Refused, "RESTART_REFUSED"):
                    session.run(reader, lifetime=10, idle=10, allow_restart=True,
                                _worker_args=("-c", "pass"))
        finally:
            os.close(writer)
        self.assertEqual(len(launches), 1 + guard.MAX_RESTARTS)
        self.assertTrue(all(child.returncode is not None for child in launches))
        session.cleanup()
        self.assertFalse(self.root.exists())

    def test_substituted_marker_refuses_restart_before_new_child(self):
        session = self.session()
        session.start(_worker_args=("-c", "pass"))
        session.stop()
        original = session.child
        record = dict(session.record, owner="cd" * 32)
        guard.write_marker(session.root, record)
        with self.assertRaisesRegex(guard.Refused, "OWNERSHIP_CHANGED"):
            session.restart(_worker_args=("-c", "pass"))
        self.assertIs(session.child, original)
        guard.write_marker(session.root, session.record)
        session.cleanup()
        self.assertFalse(self.root.exists())

    def test_idle_controller_is_bounded_and_ignoring_child_is_killed_and_reaped(self):
        session = self.session()
        reader, writer = self.pipe()
        try:
            receipt = session.run(reader, lifetime=2, idle=0.2, _worker_args=("-c", CHILD))
        finally:
            os.close(writer)
        self.assertEqual(receipt["endReason"], "controller_timeout")
        self.assertEqual(session.child.returncode, -signal.SIGKILL)
        self.assertFalse(self.root.exists())

    def test_keepalives_do_not_extend_absolute_lifetime(self):
        session = self.session()
        reader, writer = self.pipe()
        finished = threading.Event()
        def pulses():
            try:
                while not finished.wait(0.02):
                    os.write(writer, b"keepalive\n")
            finally:
                os.close(writer)
        thread = threading.Thread(target=pulses)
        thread.start()
        try:
            receipt = session.run(reader, lifetime=0.4, idle=0.2, _worker_args=("-c", CHILD))
        finally:
            finished.set()
            thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(receipt["endReason"], "lifetime")
        self.assertEqual(session.child.returncode, -signal.SIGKILL)
        self.assertFalse(self.root.exists())

    def test_clock_uses_suspend_aware_boottime(self):
        with patch.object(guard.time, "clock_gettime", return_value=123.5) as clock:
            self.assertEqual(guard.boot_now(), 123.5)
            clock.assert_called_once_with(guard.time.CLOCK_BOOTTIME)

    def test_elapsed_suspend_gap_does_not_restart_probe_lifetime(self):
        session = self.session()
        session.start(_worker_args=("-c", CHILD))
        self.wait_ready()
        reader, writer = self.pipe()
        try:
            with patch.object(session, "start"), patch.object(guard, "boot_now", side_effect=[10, 10, 130]):
                receipt = session.run(reader, lifetime=90, idle=12)
        finally:
            os.close(writer)
        self.assertEqual(receipt["endReason"], "lifetime")
        self.assertEqual(session.child.returncode, -signal.SIGKILL)
        self.assertFalse(self.root.exists())

    def test_actual_controller_sigkill_closes_lease_stops_worker_and_cleans(self):
        reader, writer = self.pipe()
        controller = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"],
                                      pass_fds=(writer,), stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL)
        self.addCleanup(self.reap, controller)
        supervisor = self.helper(reader)
        os.close(writer)  # The actual controller is now the sole pipe writer.
        self.wait_ready()
        controller.kill()
        controller.wait(timeout=3)
        out, err = supervisor.communicate(timeout=5)
        self.assertEqual(supervisor.returncode, 0, err.decode())
        receipt = json.loads(out)
        self.assertEqual(receipt["endReason"], "controller_eof")
        self.assertTrue(receipt["cleanupComplete"])
        self.assertFalse(self.root.exists())

    def test_controller_sigkill_in_restart_mode_cleans_after_worker_loss(self):
        reader, writer = self.pipe()
        controller = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"],
                                      pass_fds=(writer,), stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL)
        self.addCleanup(self.reap, controller)
        supervisor = self.helper(reader, allow_restart=True)
        os.close(writer)
        self.wait_ready()
        record = json.loads((self.root / guard.MARKER).read_text())
        guard.stop_recorded_child(record["child"], record["artifact"])
        self.assertTrue(self.root.exists(), "dead worker retains its fixture while controller lives")
        self.assertIsNone(supervisor.poll())
        controller.kill()
        controller.wait(timeout=3)
        out, err = supervisor.communicate(timeout=5)
        self.assertEqual(supervisor.returncode, 0, err.decode())
        receipt = json.loads(out)
        self.assertEqual(receipt["endReason"], "controller_eof")
        self.assertTrue(receipt["restartMode"])
        self.assertTrue(receipt["cleanupComplete"])
        self.assertFalse(self.root.exists())

    def test_supervisor_signal_drains_child_and_cleans(self):
        reader, writer = self.pipe()
        supervisor = self.helper(reader)
        try:
            self.wait_ready()
            supervisor.terminate()
            out, err = supervisor.communicate(timeout=5)
        finally:
            os.close(writer)
        self.assertEqual(supervisor.returncode, 0, err.decode())
        self.assertEqual(json.loads(out)["endReason"], "supervisor_signal")
        self.assertFalse(self.root.exists())

    def test_killed_supervisor_is_adopted_with_pidfd_and_orphan_reaped(self):
        # Subreaper applies only to this test process, not the host globally.
        libc = ctypes.CDLL(None, use_errno=True)
        old = ctypes.c_int()
        self.assertEqual(libc.prctl(37, ctypes.byref(old), 0, 0, 0), 0)
        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)
        reader, writer = self.pipe()
        supervisor = self.helper(reader)
        orphan = None
        try:
            self.wait_ready()
            record = json.loads((self.root / guard.MARKER).read_text())
            orphan = record["child"]["pid"]
            supervisor.kill()
            supervisor.wait(timeout=3)
            adopted = self.adopted()
            adopted.cleanup()
            pid, status = os.waitpid(orphan, 0)
            self.assertEqual(pid, orphan)
            self.assertTrue(os.WIFSIGNALED(status))
            self.assertEqual(os.WTERMSIG(status), signal.SIGKILL)
            orphan = None
            self.assertFalse(self.root.exists())
        finally:
            os.close(writer)
            if orphan is not None:
                # Known fixture child identity, never a guessed external PID.
                current = guard.process_identity(orphan)
                if current is not None and guard.live_matches(record["child"], current):
                    guard.stop_recorded_child(record["child"], record["artifact"])
                    os.waitpid(orphan, 0)
            self.assertEqual(libc.prctl(36, old.value, 0, 0, 0), 0)

    def test_live_supervisor_flock_refuses_second_owner_without_lock_unlink(self):
        session = self.session()
        inode = (self.root / guard.LOCK).stat().st_ino
        with self.assertRaisesRegex(guard.Refused, "^SUPERVISOR_ACTIVE$"):
            self.adopted()
        self.assertEqual((self.root / guard.LOCK).stat().st_ino, inode)
        session.cleanup()

    def test_inherited_lock_closes_unregistered_child_cleanup_window(self):
        session = self.session()
        program = "import sys,time;print('ready',flush=True);time.sleep(30)"
        child = subprocess.Popen([sys.executable, "-c", program], pass_fds=(session.lock,),
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.addCleanup(self.reap, child)
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(3))
        self.assertEqual(child.stdout.readline(), b"ready\n")
        inode = (self.root / guard.LOCK).stat().st_ino
        session.close()  # Simulate loss of the parent's descriptor.
        with self.assertRaisesRegex(guard.Refused, "^SUPERVISOR_ACTIVE$"):
            self.adopted()
        self.assertIsNone(child.poll())
        self.assertEqual((self.root / guard.LOCK).stat().st_ino, inode)
        child.kill()
        child.wait(timeout=3)
        self.adopted().cleanup()
        self.assertFalse(self.root.exists())

    def test_actual_store_flock_blocks_cleanup_and_preserves_diagnostic_inode(self):
        session = self.session()
        lock = self.root / ".lock"
        with lock.open("w+") as file:
            lock.chmod(0o600)
            file.write("synthetic-held-lock")
            file.flush()
            inode = lock.stat().st_ino
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(guard.Refused, "^STORE_STILL_OWNED$"):
                session.cleanup()
            self.assertEqual(lock.stat().st_ino, inode)
            self.assertEqual(lock.read_text(), "synthetic-held-lock")
            self.assertTrue(self.artifact.exists())
        session.cleanup()

    def test_substituted_root_and_guard_lock_are_never_deleted(self):
        session = self.session()
        old = self.base / "original"
        self.root.rename(old)
        self.root.mkdir(mode=0o700)
        sentinel = self.root / "unrelated"
        sentinel.write_text("preserve")
        with self.assertRaisesRegex(guard.Refused, "^ROOT_SUBSTITUTED$"):
            session.cleanup()
        self.assertEqual(sentinel.read_text(), "preserve")
        sentinel.unlink()
        self.root.rmdir()
        old.rename(self.root)
        (self.root / guard.LOCK).unlink()
        (self.root / guard.LOCK).write_text("substituted")
        with self.assertRaisesRegex(guard.Refused, "^LOCK_SUBSTITUTED$"):
            session.cleanup()
        self.assertTrue(self.artifact.exists())

    def test_wrong_owner_and_changed_marker_refuse_without_deletion(self):
        session = self.session()
        session.close()
        with self.assertRaisesRegex(guard.Refused, "^OWNERSHIP_CHANGED$"):
            self.adopted(owner="cd" * 32)
        data = json.loads((self.root / guard.MARKER).read_text())
        data["nodeId"] = 2
        (self.root / guard.MARKER).write_text(json.dumps(data))
        with self.assertRaisesRegex(guard.Refused, "^OWNERSHIP_CHANGED$"):
            self.adopted()
        self.assertTrue(self.artifact.exists())

    def test_unrelated_process_executable_and_start_identity_are_not_signaled(self):
        session = self.session()
        session.close()
        unrelated = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(self.reap, unrelated)
        data = json.loads((self.root / guard.MARKER).read_text())
        data["child"] = guard.process_identity(unrelated.pid)
        (self.root / guard.MARKER).write_text(json.dumps(data))
        adopted = self.adopted()
        with self.assertRaisesRegex(guard.Refused, "^PROCESS_EXECUTABLE_CHANGED$"):
            adopted.cleanup()
        self.assertIsNone(unrelated.poll())
        self.assertTrue(self.artifact.exists())
        adopted.close()
        data["child"]["start"] += 1
        (self.root / guard.MARKER).write_text(json.dumps(data))
        adopted = self.adopted()
        with self.assertRaisesRegex(guard.Refused, "^PROCESS_IDENTITY_CHANGED$"):
            adopted.cleanup()
        self.assertIsNone(unrelated.poll())

    def test_symlinks_are_not_followed_and_cleanup_budget_is_checked_before_delete(self):
        session = self.session()
        outside = self.base / "outside"
        outside.mkdir()
        sentinel = outside / "keep"
        sentinel.write_text("preserve")
        (self.root / "link").symlink_to(outside, target_is_directory=True)
        session.cleanup()
        self.assertEqual(sentinel.read_text(), "preserve")

    def test_excess_inventory_refuses_before_removing_any_file(self):
        session = self.session()
        for n in range(1025):
            (self.root / f"extra-{n}").touch()
        with self.assertRaisesRegex(guard.Refused, "^CLEANUP_LIMIT$"):
            session.cleanup()
        self.assertTrue(self.artifact.exists())
        self.assertTrue((self.root / "extra-0").exists())

    def test_bad_controller_frame_stops_child_and_stays_explicitly_refused(self):
        session = self.session()
        reader, writer = self.pipe()
        os.write(writer, b"not-a-control-command\n")
        try:
            with self.assertRaisesRegex(guard.Refused, "^CONTROLLER_PROTOCOL$"):
                session.run(reader, lifetime=2, idle=1, _worker_args=("-c", CHILD))
        finally:
            os.close(writer)
        self.assertIsNotNone(session.child.returncode)
        self.assertTrue(self.root.exists())  # No false cleanup-success receipt.
        session.cleanup()

    def test_oversized_controller_frame_is_bounded_and_child_stopped(self):
        session = self.session()
        reader, writer = self.pipe()
        os.write(writer, b"x" * 1025)
        try:
            with self.assertRaisesRegex(guard.Refused, "^CONTROLLER_LIMIT$"):
                session.run(reader, lifetime=2, idle=1, _worker_args=("-c", CHILD))
        finally:
            os.close(writer)
        self.assertIsNotNone(session.child.returncode)
        session.cleanup()

    def test_invalid_deadlines_refuse_before_spawning(self):
        session = self.session()
        reader, writer = self.pipe()
        try:
            for lifetime, idle in [(float("nan"), 1), (float("inf"), 1), (True, 1),
                                   (121, 1), (1, 31), (0.01, 0.01), (1, 2)]:
                with self.assertRaisesRegex(guard.Refused, "^INVALID_DEADLINE$"):
                    session.run(reader, lifetime=lifetime, idle=idle, _worker_args=("-c", CHILD))
                self.assertIsNone(session.child)
        finally:
            os.close(writer)
        session.cleanup()

    def test_malformed_oversized_duplicate_and_linked_markers_refuse(self):
        session = self.session()
        session.close()
        marker = self.root / guard.MARKER
        original = marker.read_bytes()
        for body, failure in [(b"x" * 4097, guard.Refused),
                              (b'{"owner":1,"owner":2}', guard.Refused),
                              (b"{", ValueError)]:
            marker.write_bytes(body)
            with self.assertRaises(failure):
                self.adopted()
            self.assertTrue(self.artifact.exists())
        marker.write_bytes(original)
        os.link(marker, self.base / "linked-marker")
        with self.assertRaisesRegex(guard.Refused, "^UNSAFE_FILE$"):
            self.adopted()

    def test_frozen_artifact_substitution_refuses_without_deletion(self):
        session = self.session()
        self.artifact.chmod(0o600)
        with self.assertRaisesRegex(guard.Refused, "^ARTIFACT_CHANGED$"):
            session.cleanup()
        self.assertTrue(self.artifact.exists())

    def test_cli_adoption_identity_refusal_has_no_traceback_or_signal(self):
        session = self.session()
        session.close()
        unrelated = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(self.reap, unrelated)
        data = json.loads((self.root / guard.MARKER).read_text())
        data["child"] = guard.process_identity(unrelated.pid)
        (self.root / guard.MARKER).write_text(json.dumps(data))
        result = subprocess.run([sys.executable, str(SCRIPT), "cleanup", "--root", str(self.root),
                                 "--owner", OWNER, "--artifact-sha256", self.sha, "--node-id", "1"],
                                capture_output=True, timeout=5,
                                env={"PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr, b"")
        self.assertFalse(json.loads(result.stdout)["cleanupComplete"])
        self.assertIsNone(unrelated.poll())
        self.assertTrue(self.root.exists())

    def test_artifact_digest_public_file_and_hardlink_refuse(self):
        directory = os.open(self.root, guard.DIR_FLAGS)
        try:
            with self.assertRaisesRegex(guard.Refused, "^ARTIFACT_CHANGED$"):
                guard.check_artifact(directory, "00" * 32)
        finally:
            os.close(directory)
        self.artifact.chmod(0o755)
        with self.assertRaisesRegex(guard.Refused, "^PUBLIC_OR_FOREIGN_FILE$"):
            guard.Session(str(self.root), OWNER, self.sha, 1, claim=True, synthetic=True)
        self.assertEqual(set(p.name for p in self.root.iterdir()), {guard.ARTIFACT})
        self.artifact.chmod(0o700)
        os.link(self.artifact, self.base / "linked-artifact")
        with self.assertRaisesRegex(guard.Refused, "^UNSAFE_FILE$"):
            guard.Session(str(self.root), OWNER, self.sha, 1, claim=True, synthetic=True)
        self.assertEqual(set(p.name for p in self.root.iterdir()), {guard.ARTIFACT})

    def test_cli_refusal_is_redacted(self):
        child = subprocess.run([sys.executable, str(SCRIPT), "cleanup", "--root", str(self.root),
                                "--owner", OWNER, "--artifact-sha256", self.sha, "--node-id", "1"],
                               capture_output=True, timeout=5,
                               env={"PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(child.returncode, 2)
        self.assertFalse(json.loads(child.stdout)["cleanupComplete"])
        self.assertNotIn(str(self.root).encode(), child.stdout + child.stderr)
        self.assertNotIn(OWNER.encode(), child.stdout + child.stderr)

    def test_deep_marker_refusal_is_redacted_without_traceback(self):
        session = self.session()
        session.close()
        (self.root / guard.MARKER).write_bytes(b'{"nested":' + b'[' * 1200 + b']' * 1200 + b'}')
        result = subprocess.run([sys.executable, str(SCRIPT), "cleanup", "--root", str(self.root),
                                 "--owner", OWNER, "--artifact-sha256", self.sha, "--node-id", "1"],
                                capture_output=True, timeout=5,
                                env={"PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr, b"")
        self.assertFalse(json.loads(result.stdout)["cleanupComplete"])
        self.assertTrue(self.root.exists())


if __name__ == "__main__":
    unittest.main()
