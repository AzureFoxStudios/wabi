#!/usr/bin/env python3
"""Linux-only lifetime/cleanup guard for an explicitly disposable RPC probe.

This does not create keys, configure networking, grant a writer permit or start
Wabi. The public CLI runs only the frozen ignored recovery-worker test. Module
tests may supply a synthetic child instead. No child output is published.
"""
import argparse
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

SCRIPT = Path(__file__).resolve()
MARKER = ".rpc-supervisor.json"
LOCK = ".rpc-supervisor.lock"
ARTIFACT = "probe.bin"
PURPOSE = "wabi-disposable-recovery-rpc-v1"
WORKER_ARGS = ("--exact", "processes::separate_process_recovery_worker",
               "--ignored", "--test-threads=1")
MAX_RESTARTS = 8
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


class Refused(Exception):
    """Fixed reason codes only; never expose exception text or private paths."""


def require(condition, reason):
    if not condition:
        raise Refused(reason)


def hex64(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def boot_now():
    # Linux BOOTTIME includes suspend. A sleeping laptop must not return with
    # a fresh-looking remaining probe lifetime or controller lease.
    require(hasattr(time, "CLOCK_BOOTTIME"), "PLATFORM_UNSUPPORTED")
    return time.clock_gettime(time.CLOCK_BOOTTIME)


def identity(info):
    return [info.st_dev, info.st_ino]


def stamp(info):
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


def private(info, regular=False):
    require(info.st_uid == os.getuid() and not info.st_mode & 0o077, "PUBLIC_OR_FOREIGN_FILE")
    if regular:
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "UNSAFE_FILE")


def root_fd(value):
    path = Path(value)
    require(path.is_absolute() and str(path) == os.path.abspath(path), "UNSAFE_ROOT")
    require(".." not in path.parts, "UNSAFE_ROOT")
    for part in [*reversed(path.parents), path]:
        require(stat.S_ISDIR(part.lstat().st_mode), "UNSAFE_ROOT")
    fd = os.open(path, DIR_FLAGS)
    try:
        private(os.fstat(fd))
        require(identity(path.lstat()) == identity(os.fstat(fd)), "ROOT_SUBSTITUTED")
        return path, fd
    except BaseException:
        os.close(fd)
        raise


def file_fd(root, name):
    fd = os.open(name, FILE_FLAGS, dir_fd=root)
    try:
        private(os.fstat(fd), regular=True)
        require(identity(os.stat(name, dir_fd=root, follow_symlinks=False)) ==
                identity(os.fstat(fd)), "FILE_SUBSTITUTED")
        return fd
    except BaseException:
        os.close(fd)
        raise


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "INVALID_RECORD")
        result[key] = value
    return result


def read_json(root, name, ceiling):
    fd = file_fd(root, name)
    try:
        before = stamp(os.fstat(fd))
        require(before[2] <= ceiling, "RECORD_LIMIT")
        body = bytearray()
        while len(body) <= ceiling:
            part = os.read(fd, min(4096, ceiling + 1 - len(body)))
            if not part:
                break
            body.extend(part)
        require(0 < len(body) <= ceiling and before == stamp(os.fstat(fd)), "RECORD_CHANGED")
        value = json.loads(body, object_pairs_hook=no_duplicates)
        require(isinstance(value, dict), "INVALID_RECORD")
        return value
    finally:
        os.close(fd)


def write_marker(root, value):
    body = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    require(len(body) <= 4096, "RECORD_LIMIT")
    temporary = ".rpc-supervisor.next"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=root)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(body)
            out.flush()
            os.fsync(out.fileno())
        os.rename(temporary, MARKER, src_dir_fd=root, dst_dir_fd=root)
        os.fsync(root)
    except BaseException:
        # A interrupted temporary record is not used as ownership evidence.
        raise


def check_artifact(root, expected):
    require(hex64(expected), "INVALID_ARTIFACT_DIGEST")
    fd = file_fd(root, ARTIFACT)
    try:
        before = stamp(os.fstat(fd))
        require(4 <= before[2] <= 256 * 1024**2, "ARTIFACT_LIMIT")
        require(os.fstat(fd).st_mode & stat.S_IXUSR, "ARTIFACT_NOT_EXECUTABLE")
        first = os.read(fd, 65536)
        require(first.startswith(b"\x7fELF"), "ARTIFACT_NOT_ELF")
        digest = hashlib.sha256(first)
        while part := os.read(fd, 65536):
            digest.update(part)
        require(digest.hexdigest() == expected and before == stamp(os.fstat(fd)),
                "ARTIFACT_CHANGED")
        return fd, before
    except BaseException:
        os.close(fd)
        raise


def process_identity(pid):
    require(type(pid) is int and 1 < pid < 2**31, "INVALID_PROCESS")
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        return {"pid": pid, "boot": boot, "start": int(fields[19]), "state": fields[0]}
    except FileNotFoundError:
        return None


def live_matches(saved, current):
    return current is not None and all(current[k] == saved[k] for k in ("pid", "boot", "start"))


def stop_recorded_child(saved, artifact_stamp):
    """Adoption after supervisor death: pidfd protects against PID reuse races."""
    require(hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"), "PLATFORM_UNSUPPORTED")
    require(isinstance(saved, dict) and set(saved) == {"pid", "boot", "start", "state"}
            and type(saved["start"]) is int and saved["start"] > 0
            and isinstance(saved["boot"], str) and isinstance(saved["state"], str), "INVALID_PROCESS")
    current = process_identity(saved["pid"])
    if current is None:
        return
    require(live_matches(saved, current), "PROCESS_IDENTITY_CHANGED")
    if current["state"] == "Z":
        return
    try:
        pidfd = os.pidfd_open(saved["pid"])
    except ProcessLookupError:
        return
    try:
        current = process_identity(saved["pid"])
        if current is None or current["state"] == "Z":
            return
        require(live_matches(saved, current), "PROCESS_IDENTITY_CHANGED")
        require(identity(os.stat(f"/proc/{saved['pid']}/exe")) == artifact_stamp[:2],
                "PROCESS_EXECUTABLE_CHANGED")
        with selectors.DefaultSelector() as selector:
            selector.register(pidfd, selectors.EVENT_READ)
            signal.pidfd_send_signal(pidfd, signal.SIGTERM)
            if not selector.select(0.5):
                signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                require(bool(selector.select(3)), "CHILD_STOP_TIMEOUT")
    finally:
        os.close(pidfd)


def inventory(root, prefix=(), result=None, counters=None):
    result = [] if result is None else result
    counters = [0, 0] if counters is None else counters
    for name in os.listdir(root):
        info = os.stat(name, dir_fd=root, follow_symlinks=False)
        counters[0] += 1
        counters[1] += info.st_size if stat.S_ISREG(info.st_mode) else 0
        require(counters[0] <= 1024 and counters[1] <= 1024**3, "CLEANUP_LIMIT")
        path = (*prefix, name)
        if stat.S_ISDIR(info.st_mode):
            nested = os.open(name, DIR_FLAGS, dir_fd=root)
            try:
                require(identity(os.fstat(nested)) == identity(info), "TREE_SUBSTITUTED")
                inventory(nested, path, result, counters)
            finally:
                os.close(nested)
        result.append((path, identity(info), stat.S_ISDIR(info.st_mode)))
    return result


def delete_entry(root, path, expected, directory):
    fds = []
    try:
        parent = root
        for name in path[:-1]:
            parent = os.open(name, DIR_FLAGS, dir_fd=parent)
            fds.append(parent)
        require(identity(os.stat(path[-1], dir_fd=parent, follow_symlinks=False)) == expected,
                "TREE_SUBSTITUTED")
        if directory:
            os.rmdir(path[-1], dir_fd=parent)
        else:
            os.unlink(path[-1], dir_fd=parent)
    finally:
        for fd in reversed(fds):
            os.close(fd)


class Session:
    def __init__(self, root, owner, artifact_sha, node_id, *, claim=False, synthetic=False):
        require(sys.platform == "linux", "PLATFORM_UNSUPPORTED")
        require(hex64(owner) and type(node_id) is int and 0 < node_id < 2**64, "INVALID_BINDING")
        self.path, self.root = root_fd(root)
        self.lock = self.artifact = None
        self.child = None
        self.cleaned = False
        self.interrupted = False
        self.stopped = False
        try:
            if claim:
                allowed = {ARTIFACT} if synthetic else {ARTIFACT, "fixture.json", "recovery.key"}
                require(set(os.listdir(self.root)) == allowed, "ROOT_ALREADY_IN_USE")
                # Refused input must not leave new guard files in the caller's
                # staging root. Validate read-only inputs before claiming it.
                self.artifact, artifact_stamp = check_artifact(self.root, artifact_sha)
                if not synthetic:
                    config = read_json(self.root, "fixture.json", 16384)
                    binding = config.get("binding")
                    require(config.get("owner") == owner and isinstance(binding, dict)
                            and binding.get("nodeId") == node_id, "FIXTURE_BINDING_CHANGED")
                    key = file_fd(self.root, "recovery.key")
                    try:
                        require(os.fstat(key).st_size == 32, "INVALID_FIXTURE_KEY")
                    finally:
                        os.close(key)
            flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
            if claim:
                flags |= os.O_CREAT | os.O_EXCL
            self.lock = os.open(LOCK, flags, 0o600, dir_fd=self.root)
            private(os.fstat(self.lock), regular=True)
            try:
                fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Refused("SUPERVISOR_ACTIVE") from None
            if not claim:
                self.artifact, artifact_stamp = check_artifact(self.root, artifact_sha)
            if claim:
                self.record = {"schemaVersion": 1, "purpose": PURPOSE, "owner": owner,
                               "nodeId": node_id, "root": identity(os.fstat(self.root)),
                               "lock": identity(os.fstat(self.lock)), "artifactSha256": artifact_sha,
                               "artifact": artifact_stamp, "synthetic": synthetic, "child": None}
                write_marker(self.root, self.record)
            else:
                self.record = read_json(self.root, MARKER, 4096)
                require(set(self.record) == {"schemaVersion", "purpose", "owner", "nodeId", "root",
                                             "lock", "artifactSha256", "artifact", "synthetic", "child"}
                        and type(self.record.get("synthetic")) is bool
                        and type(self.record.get("schemaVersion")) is int
                        and type(self.record.get("nodeId")) is int
                        and self.record.get("schemaVersion") == 1 and self.record.get("purpose") == PURPOSE
                        and self.record.get("owner") == owner and self.record.get("nodeId") == node_id
                        and self.record.get("root") == identity(os.fstat(self.root))
                        and self.record.get("lock") == identity(os.fstat(self.lock))
                        and self.record.get("artifactSha256") == artifact_sha
                        and self.record.get("artifact") == artifact_stamp, "OWNERSHIP_CHANGED")
            self.check_named()
        except BaseException:
            self.close()
            raise

    def close(self):
        for name in ("artifact", "lock", "root"):
            fd = getattr(self, name, None)
            if fd is not None:
                os.close(fd)
                setattr(self, name, None)

    def check_named(self):
        require(identity(self.path.lstat()) == self.record["root"], "ROOT_SUBSTITUTED")
        require(identity(os.stat(LOCK, dir_fd=self.root, follow_symlinks=False)) ==
                identity(os.fstat(self.lock)), "LOCK_SUBSTITUTED")
        require(read_json(self.root, MARKER, 4096) == self.record,
                "OWNERSHIP_CHANGED")
        require(stamp(os.fstat(self.artifact)) == self.record["artifact"]
                and identity(os.stat(ARTIFACT, dir_fd=self.root, follow_symlinks=False)) ==
                identity(os.fstat(self.artifact)), "ARTIFACT_CHANGED")

    def start(self, *, _worker_args=WORKER_ARGS):
        self.check_named()
        require(self.record["child"] is None, "WORKER_ALREADY_REGISTERED")
        require(self.record["synthetic"] or tuple(_worker_args) == WORKER_ARGS, "INVALID_ARGUMENTS")
        require(stamp(os.fstat(self.artifact)) == self.record["artifact"], "ARTIFACT_CHANGED")
        require(len(json.dumps(_worker_args)) <= 8192, "ARGUMENT_LIMIT")
        env = {"PYTHONDONTWRITEBYTECODE": "1", "WABI_RPC_FIXTURE_ROOT": str(self.path),
               "WABI_RPC_FIXTURE_OWNER": self.record["owner"],
               "WABI_RPC_LAUNCH_ARGS": json.dumps(_worker_args)}
        # The launcher inherits the existing flock until its PID/start is
        # durably registered. Thus a killed supervisor cannot leave an
        # unregistered child while cleanup successfully acquires the flock.
        self.stopped = False
        self.child = subprocess.Popen(
            [sys.executable, str(SCRIPT), "_launch", str(self.root), str(self.lock), str(self.artifact)],
            env=env, pass_fds=(self.root, self.lock, self.artifact),
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = boot_now() + 3
        while boot_now() < deadline:
            record = read_json(self.root, MARKER, 4096)
            if record.get("child") is not None:
                require(record["child"]["pid"] == self.child.pid, "PROCESS_IDENTITY_CHANGED")
                self.record = record
                return
            require(self.child.poll() is None, "LAUNCHER_REFUSED")
            time.sleep(0.01)
        raise Refused("LAUNCHER_TIMEOUT")

    def stop(self):
        if self.stopped:
            return
        if self.child is not None:
            if self.child.poll() is None:
                self.child.terminate()
                try:
                    self.child.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait(timeout=3)
            self.stopped = True
            return
        saved = self.record["child"]
        if saved is not None:
            stop_recorded_child(saved, self.record["artifact"])
        self.stopped = True

    def restart(self, *, _worker_args=WORKER_ARGS):
        # Keep the original supervisor lock and durable fixture intact. Only
        # the directly owned worker may be stopped/reaped before replacement.
        # No new root, key, binding, executable or process arguments are adopted.
        self.check_named()
        require(self.child is not None, "NO_OWNED_WORKER")
        self.stop()
        self.child = None
        self.record["child"] = None
        write_marker(self.root, self.record)
        self.start(_worker_args=_worker_args)

    def cleanup(self):
        self.check_named()
        self.stop()
        core_lock = None
        try:
            try:
                core_lock = file_fd(self.root, ".lock")
            except FileNotFoundError:
                pass
            if core_lock is not None:
                try:
                    fcntl.flock(core_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise Refused("STORE_STILL_OWNED") from None
            entries = inventory(self.root)
            self.check_named()
            # Remove the ownership record and lock names last; lock descriptors
            # remain held throughout final disposal, never to admit a writer.
            protected = {MARKER, LOCK, ".lock"}
            for path, expected, directory in sorted(entries, key=lambda e: e[0][0] in protected):
                delete_entry(self.root, path, expected, directory)
            parent = os.open(self.path.parent, DIR_FLAGS)
            try:
                require(identity(os.stat(self.path.name, dir_fd=parent, follow_symlinks=False)) ==
                        self.record["root"], "ROOT_SUBSTITUTED")
                os.rmdir(self.path.name, dir_fd=parent)
                os.fsync(parent)
            finally:
                os.close(parent)
            self.cleaned = True
        finally:
            if core_lock is not None:
                os.close(core_lock)

    def run(self, controller_fd, *, lifetime=90, idle=12, allow_restart=False,
            _worker_args=WORKER_ARGS):
        for value, ceiling in ((lifetime, 120), (idle, 30)):
            require(type(value) in (int, float) and math.isfinite(value) and 0.05 <= value <= ceiling,
                    "INVALID_DEADLINE")
        require(idle <= lifetime, "INVALID_DEADLINE")
        require(type(allow_restart) is bool, "INVALID_RESTART_MODE")
        reason = "refused"
        restarts = 0
        try:
            deadline = boot_now() + lifetime
            self.start(_worker_args=_worker_args)
            heartbeat = min(deadline, boot_now() + idle)
            buffer = bytearray()
            with selectors.DefaultSelector() as selector:
                selector.register(controller_fd, selectors.EVENT_READ)
                while True:
                    now = boot_now()
                    if self.interrupted:
                        reason = "supervisor_signal"
                        break
                    if self.child.poll() is not None and not allow_restart:
                        reason = "worker_exit"
                        break
                    if now >= deadline or now >= heartbeat:
                        reason = "lifetime" if now >= deadline else "controller_timeout"
                        break
                    if not selector.select(min(0.05, deadline - now, heartbeat - now)):
                        continue
                    data = os.read(controller_fd, 1024)
                    if not data:
                        reason = "controller_eof"
                        break
                    require(len(buffer) + len(data) <= 1024, "CONTROLLER_LIMIT")
                    buffer.extend(data)
                    while b"\n" in buffer:
                        line, _, rest = buffer.partition(b"\n")
                        buffer = bytearray(rest)
                        require(line in (b"keepalive", b"stop", b"restart"), "CONTROLLER_PROTOCOL")
                        if line == b"stop":
                            reason = "controller_stop"
                            break
                        if line == b"restart":
                            require(allow_restart and restarts < MAX_RESTARTS,
                                    "RESTART_REFUSED")
                            require(boot_now() < min(deadline, heartbeat), "RESTART_EXPIRED")
                            self.restart(_worker_args=_worker_args)
                            restarts += 1
                        else:
                            heartbeat = min(deadline, boot_now() + idle)
                    if reason == "controller_stop":
                        break
        finally:
            self.stop()
        self.cleanup()
        return {"schemaVersion": 1, "result": "PASS", "scope": "disposable_process_lifetime_cleanup",
                "endReason": reason, "synthetic": self.record["synthetic"],
                "restartMode": allow_restart, "workerRestarts": restarts,
                "ownedChildStopped": True, "cleanupComplete": self.cleaned,
                "encryptedRpcTested": False, "automaticWabiRecoveryTested": False}


def launch(root, lock, artifact):
    record = read_json(root, MARKER, 4096)
    require(identity(os.fstat(root)) == record["root"] and identity(os.fstat(lock)) == record["lock"]
            and stamp(os.fstat(artifact)) == record["artifact"], "OWNERSHIP_CHANGED")
    record["child"] = process_identity(os.getpid())
    write_marker(root, record)
    # Keep the inherited lock through registration; close it atomically with
    # exec. The parent still owns its descriptor while alive.
    os.set_inheritable(lock, False)
    os.set_inheritable(root, False)
    os.set_inheritable(artifact, False)
    args = json.loads(os.environ["WABI_RPC_LAUNCH_ARGS"])
    require(isinstance(args, list) and all(isinstance(s, str) for s in args), "INVALID_ARGUMENTS")
    require(record["synthetic"] or tuple(args) == WORKER_ARGS, "INVALID_ARGUMENTS")
    os.execve(f"/proc/self/fd/{artifact}", [ARTIFACT, *args],
              {"WABI_RPC_FIXTURE_ROOT": os.environ["WABI_RPC_FIXTURE_ROOT"],
               "WABI_RPC_FIXTURE_OWNER": os.environ["WABI_RPC_FIXTURE_OWNER"],
               "PYTHONDONTWRITEBYTECODE": "1"})


def main():
    if len(sys.argv) == 5 and sys.argv[1] == "_launch":
        launch(*(int(n) for n in sys.argv[2:]))
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("supervise", "cleanup"))
    parser.add_argument("--root", required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--artifact-sha256", required=True)
    parser.add_argument("--node-id", type=int, required=True)
    parser.add_argument("--lifetime", type=int, default=90)
    parser.add_argument("--idle", type=int, default=12)
    parser.add_argument("--allow-restart", action="store_true",
                        help="Keep the same owned store across up to eight controller-requested worker restarts")
    args = parser.parse_args()
    session = None
    stopped = [False]
    def interrupt(_signal, _frame):
        stopped[0] = True
        if session is not None:
            session.interrupted = True
    previous = {sig: signal.signal(sig, interrupt) for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
    try:
        session = Session(args.root, args.owner, args.artifact_sha256, args.node_id,
                          claim=args.action == "supervise")
        session.interrupted = stopped[0]
        if args.action == "supervise":
            result = session.run(sys.stdin.fileno(), lifetime=args.lifetime, idle=args.idle,
                                 allow_restart=args.allow_restart)
        else:
            session.cleanup()
            result = {"schemaVersion": 1, "result": "PASS", "scope": "disposable_process_cleanup",
                      "cleanupComplete": True, "encryptedRpcTested": False,
                      "automaticWabiRecoveryTested": False}
        print(json.dumps(result, sort_keys=True))
        return 0
    except (Refused, OSError, ValueError, KeyError, TypeError, RecursionError, subprocess.SubprocessError):
        print(json.dumps({"schemaVersion": 1, "result": "REFUSED", "reason": "fixture_supervision_refused",
                          "cleanupComplete": False, "encryptedRpcTested": False,
                          "automaticWabiRecoveryTested": False}, sort_keys=True))
        return 2
    finally:
        if session is not None:
            try:
                # Only a directly spawned child belongs to this exception
                # backstop. Never retry a refused adoption signal operation.
                if session.child is not None:
                    session.stop()
            except (Refused, OSError, subprocess.SubprocessError):
                pass
            finally:
                session.close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    raise SystemExit(main())
