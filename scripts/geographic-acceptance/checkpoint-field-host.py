#!/usr/bin/env python3
"""Owned, bounded Linux process/scratch guard for the ciphertext field fixture.

Borrows only read-only/private-file, PID-identity and tree-disposal primitives
from the existing probe guard. It does not alter its worker grammar or purpose.
No service installation, firewall operation, live Wabi data or arbitrary command.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys

spec = importlib.util.spec_from_file_location(
    "checkpoint_guard_primitives", Path(__file__).with_name("rpc-probe-supervisor.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

PURPOSE = "wabi-disposable-checkpoint-ciphertext-v1"
MARKER = ".checkpoint-field-host.json"
LOCK = ".checkpoint-field-host.lock"
ARGS = ("--exact", "checkpoint_ciphertext_worker", "--ignored", "--test-threads=1", "--nocapture")
ALLOWED = {"serve", "seed", "push", "pull", "receipt", "remote_receipt"}


def markers(output, tag):
    output = bytes(output)
    allowed_prefixes = {b"", b"test checkpoint_ciphertext_worker ... "}
    result = []
    for framed in output.splitlines(keepends=True):
        # A pipe read can stop anywhere inside JSON. Never parse or announce
        # a partial line; the next read supplies its actual terminating LF.
        if not framed.endswith(b"\n"):
            continue
        line = framed[:-1]
        before, separator, after = line.partition(tag)
        if separator:
            guard.require(before in allowed_prefixes, "WORKER_RESULT_PREFIX")
            result.append(after)
    return result


def result_markers(output):
    return markers(output, b"WABI_CHECKPOINT_RESULT_V1 ")


def listener_ready(output, node, manifest):
    ready = markers(output, b"WABI_CHECKPOINT_LISTEN_V1 ")
    if not ready:
        return None
    guard.require(len(ready) == 1, "WORKER_LISTEN_CHANGED")
    value = json.loads(ready[0], object_pairs_hook=guard.no_duplicates)
    guard.require(isinstance(value, dict) and set(value) == {"nodeId", "manifestSha256"}
                  and type(value["nodeId"]) is int and value["nodeId"] == node
                  and guard.hex64(value["manifestSha256"]) and value["manifestSha256"] == manifest,
                  "WORKER_LISTEN_CHANGED")
    return {"schemaVersion": 1, "purpose": PURPOSE, "listening": True, **value}


def publish(root, record):
    body = json.dumps(record, sort_keys=True, separators=(",", ":")).encode()
    guard.require(len(body) <= 4096, "RECORD_LIMIT")
    fd = os.open(".checkpoint-field-host.next", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=root)
    with os.fdopen(fd, "wb") as output:
        output.write(body)
        output.flush()
        os.fsync(output.fileno())
    os.rename(".checkpoint-field-host.next", MARKER, src_dir_fd=root, dst_dir_fd=root)
    os.fsync(root)


class Host:
    def __init__(self, path, owner, sha, node, *, claim=False):
        guard.require(sys.platform == "linux" and guard.hex64(owner) and guard.hex64(sha)
                      and type(node) is int and node in (1, 2, 3), "INVALID_BINDING")
        self.path, self.root = guard.root_fd(path)
        self.artifact = self.lock = self.material_lock = None
        self.child = None
        self.worker_failure = None
        self.cleaned = False
        try:
            guard.require(self.path.parent == Path("/tmp")
                          and self.path.name.startswith("wabi-checkpoint-field-"), "UNSAFE_ROOT")
            self.artifact, stamp = guard.check_artifact(self.root, sha)
            fixture = guard.read_json(self.root, "fixture.json", 16384)
            guard.require(set(fixture) == {"schemaVersion", "purpose", "owner", "binding", "peers",
                                         "bindAddress", "sourceNode", "manifestSha256", "lifetimeSeconds"}
                          and type(fixture["schemaVersion"]) is int and fixture["schemaVersion"] == 1
                          and fixture["purpose"] == PURPOSE and fixture["owner"] == owner
                          and type(fixture["binding"].get("nodeId")) is int
                          and fixture["binding"].get("nodeId") == node
                          and guard.hex64(fixture["manifestSha256"])
                          and type(fixture["lifetimeSeconds"]) is int
                          and 30 <= fixture["lifetimeSeconds"] <= 300, "FIXTURE_BINDING_CHANGED")
            self.fixture = fixture
            key = guard.file_fd(self.root, "recovery.key")
            try:
                guard.require(os.fstat(key).st_size == 32, "INVALID_KEY")
            finally:
                os.close(key)
            if claim:
                allowed = {"probe.bin", "bootstrap.json", "fixture.json", "recovery.key"}
                if node == 1:
                    allowed |= {"ciphertext.age", "manifest.json"}
                guard.require(set(os.listdir(self.root)) == allowed, "ROOT_ALREADY_IN_USE")
            self.lock = os.open(LOCK, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
                                | (os.O_CREAT | os.O_EXCL if claim else 0), 0o600, dir_fd=self.root)
            guard.private(os.fstat(self.lock), regular=True)
            if claim:
                self.record = {"schemaVersion": 1, "purpose": PURPOSE, "owner": owner,
                               "nodeId": node, "root": guard.identity(os.fstat(self.root)),
                               "lock": guard.identity(os.fstat(self.lock)), "artifactSha256": sha,
                               "artifact": stamp, "child": None,
                               "fixtureSha256": self.config_digest()}
                self.exclusive()
                publish(self.root, self.record)
            else:
                self.record = guard.read_json(self.root, MARKER, 4096)
                guard.require(set(self.record) == {"schemaVersion", "purpose", "owner", "nodeId", "root",
                                                  "lock", "artifactSha256", "artifact", "child", "fixtureSha256"}
                              and self.record["schemaVersion"] == 1 and self.record["purpose"] == PURPOSE
                              and self.record["owner"] == owner and self.record["nodeId"] == node
                              and self.record["artifactSha256"] == sha and self.record["artifact"] == stamp,
                              "OWNERSHIP_CHANGED")
            self.check()
        except BaseException:
            self.close()
            raise

    def config_digest(self):
        return hashlib.sha256(json.dumps(self.fixture, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    def exclusive(self):
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise guard.Refused("FIELD_WORKER_ACTIVE") from None

    def check(self):
        guard.require(guard.identity(self.path.lstat()) == self.record["root"]
                      and guard.identity(os.fstat(self.root)) == self.record["root"]
                      and guard.identity(os.stat(LOCK, dir_fd=self.root, follow_symlinks=False)) == self.record["lock"]
                      and guard.identity(os.fstat(self.lock)) == self.record["lock"], "ROOT_SUBSTITUTED")
        guard.require(guard.stamp(os.fstat(self.artifact)) == self.record["artifact"]
                      and guard.identity(os.stat("probe.bin", dir_fd=self.root, follow_symlinks=False))
                      == self.record["artifact"][:2], "ARTIFACT_CHANGED")
        current = guard.read_json(self.root, "fixture.json", 16384)
        guard.require(current == self.fixture and self.config_digest() == self.record["fixtureSha256"]
                      and guard.read_json(self.root, MARKER, 4096) == self.record, "OWNERSHIP_CHANGED")

    def inactive(self):
        saved = self.record["child"]
        if saved is not None:
            current = guard.process_identity(saved["pid"])
            guard.require(current is None or (guard.live_matches(saved, current) and current["state"] == "Z"),
                          "FIELD_WORKER_ACTIVE")

    def stop(self):
        self.check()
        if self.record["child"] is not None:
            guard.stop_recorded_child(self.record["child"], self.record["artifact"])
        return {"stoppedRecordedChild": self.record["child"] is not None}

    def run(self, action, target):
        self.exclusive()
        self.check()
        self.inactive()
        guard.require(action in ALLOWED, "INVALID_ACTION")
        if action in {"push", "pull", "remote_receipt"}:
            guard.require(type(target) is int and target in (1, 2, 3)
                          and target != self.record["nodeId"], "INVALID_TARGET")
        else:
            guard.require(target is None, "INVALID_TARGET")
        env = {"WABI_CHECKPOINT_FIXTURE_ROOT": str(self.path),
               "WABI_CHECKPOINT_FIXTURE_OWNER": self.record["owner"],
               "WABI_CHECKPOINT_FIXTURE_ACTION": action}
        if target is not None:
            env["WABI_CHECKPOINT_FIXTURE_TARGET"] = str(target)
        # The child retains the same flock through exec and until actual exit.
        # If this parent dies before PID publication, cleanup still refuses
        # while the worker owns that lock; its independent watchdog is bounded.
        self.child = subprocess.Popen([f"/proc/self/fd/{self.artifact}", *ARGS], env=env,
                                      pass_fds=(self.artifact, self.lock), stdin=subprocess.DEVNULL,
                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.record["child"] = guard.process_identity(self.child.pid)
        guard.require(self.record["child"] is not None, "WORKER_EXITED_BEFORE_REGISTRATION")
        publish(self.root, self.record)
        end = guard.boot_now() + (self.fixture["lifetimeSeconds"] + 20 if action == "serve" else 120)
        output = bytearray()
        announced = False
        try:
            os.set_blocking(self.child.stdout.fileno(), False)
            with selectors.DefaultSelector() as selector:
                selector.register(self.child.stdout, selectors.EVENT_READ)
                while selector.get_map():
                    guard.require(guard.boot_now() < end, "WORKER_DEADLINE")
                    for key, _ in selector.select(min(0.2, max(0, end - guard.boot_now()))):
                        part = os.read(key.fd, 65536)
                        if not part:
                            selector.unregister(key.fileobj)
                        else:
                            output.extend(part)
                            guard.require(len(output) <= 1024 * 1024, "OUTPUT_LIMIT")
                            if action == "serve" and not announced:
                                ready = listener_ready(output, self.record["nodeId"], self.fixture["manifestSha256"])
                                if ready:
                                    print(json.dumps(ready), flush=True)
                                    announced = True
                code = self.child.wait(timeout=3)
            self.check()
            result_rows = result_markers(output)
            self.worker_failure = {"actualExitCode": code, "outputSha256": hashlib.sha256(output).hexdigest()}
            match = re.search(rb'Err.*value: (Io|Refused|Authentication|Deadline|Protocol|Budget)\b', output)
            if match:
                self.worker_failure["rustTransportError"] = match[1].decode()
            match = re.search(rb'Os \{ code: ([0-9]+)', output)
            if match:
                self.worker_failure["rustOsErrorCode"] = int(match[1])
            guard.require(code == 0 and len(result_rows) == 1, "WORKER_REFUSED")
            result = json.loads(result_rows[0], object_pairs_hook=guard.no_duplicates)
            guard.require(result["schemaVersion"] == 1 and result["purpose"] == PURPOSE
                          and result["nodeId"] == self.record["nodeId"] and result["action"] == action
                          and result["manifestSha256"] == self.fixture["manifestSha256"]
                          and result["canonicalWriterPermitted"] is False, "WORKER_RESULT_CHANGED")
            return {"actualExitCode": code, "outputSha256": hashlib.sha256(output).hexdigest(), "result": result}
        finally:
            if self.child.poll() is None:
                self.child.kill()
            self.child.wait(timeout=3)
            if self.worker_failure is None:
                self.worker_failure = {"actualExitCode": self.child.returncode,
                                       "outputSha256": hashlib.sha256(output).hexdigest()}
            self.child.stdout.close()
            # Keep the terminated PID record as evidence; never manufacture an
            # operation receipt or erase uncertain work after timeout/failure.

    def lock_material(self):
        material = os.open("material", guard.DIR_FLAGS, dir_fd=self.root)
        try:
            guard.private(os.fstat(material))
            lock = guard.file_fd(material, ".lock")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BaseException:
                os.close(lock)
                raise
            self.material_lock = lock
            return material
        except BaseException:
            os.close(material)
            raise

    def lose_copy(self):
        self.exclusive()
        self.check()
        self.inactive()
        guard.require(self.record["nodeId"] == 2, "LOSS_TARGET_REFUSED")
        material = self.lock_material()
        try:
            name = self.fixture["manifestSha256"] + ".checkpoint.json"
            manifest = guard.read_json(material, name, 256 * 1024)
            encoded = json.dumps(manifest, separators=(",", ":"), ensure_ascii=False).encode()
            guard.require(hashlib.sha256(encoded).hexdigest() == self.fixture["manifestSha256"], "MANIFEST_CHANGED")
            objects = manifest.get("objects")
            guard.require(isinstance(objects, list) and 0 < len(objects) <= 1024, "OBJECT_LIMIT")
            names = {}
            total = 0
            for object_ in objects:
                guard.require(guard.hex64(object_.get("sha256")) and type(object_.get("bytes")) is int
                              and 0 < object_["bytes"] <= 65536, "INVALID_OBJECT")
                blob = object_["sha256"] + ".blob"
                fd = guard.file_fd(material, blob)
                try:
                    before = guard.stamp(os.fstat(fd))
                    guard.require(before[2] == object_["bytes"], "OBJECT_CHANGED")
                    raw = os.read(fd, 65537)
                    guard.require(len(raw) == before[2] and hashlib.sha256(raw).hexdigest() == object_["sha256"]
                                  and before == guard.stamp(os.fstat(fd)), "OBJECT_CHANGED")
                    names[blob] = before[:2]
                    total += before[2]
                finally:
                    os.close(fd)
            guard.require(total <= 64 * 1024 * 1024, "OBJECT_LIMIT")
            names[name] = guard.identity(os.stat(name, dir_fd=material, follow_symlinks=False))
            lock_before = guard.identity(os.fstat(self.material_lock))
            self.check()
            for item, identity in names.items():
                guard.delete_entry(material, (item,), identity, False)
            os.fsync(material)
            guard.require(guard.identity(os.stat(".lock", dir_fd=material, follow_symlinks=False)) == lock_before,
                          "LOCK_SUBSTITUTED")
            return {"deletedCiphertextFiles": len(names)-1, "requiredBytes": total,
                    "materialLockIdentity": lock_before, "keyAndBindingPreserved": True}
        finally:
            os.close(material)

    def cleanup(self):
        self.exclusive()
        self.check()
        self.inactive()
        material = None
        if "material" in os.listdir(self.root):
            material = self.lock_material()
        try:
            entries = guard.inventory(self.root)
            self.check()
            for path, identity, directory in sorted(entries, key=lambda e: e[0][0] in {MARKER, LOCK}):
                guard.delete_entry(self.root, path, identity, directory)
            parent = os.open(self.path.parent, guard.DIR_FLAGS)
            try:
                guard.require(guard.identity(os.stat(self.path.name, dir_fd=parent, follow_symlinks=False))
                              == self.record["root"], "ROOT_SUBSTITUTED")
                os.rmdir(self.path.name, dir_fd=parent)
                os.fsync(parent)
            finally:
                os.close(parent)
            self.cleaned = True
            return {"ownedRootRemoved": True, "entries": len(entries)}
        finally:
            if material is not None:
                os.close(material)

    def close(self):
        for name in ("material_lock", "artifact", "lock", "root"):
            fd = getattr(self, name, None)
            if fd is not None:
                os.close(fd)
                setattr(self, name, None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("claim", "run", "stop", "lose_copy", "cleanup"))
    parser.add_argument("--root", required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--artifact-sha", required=True)
    parser.add_argument("--node-id", type=int, required=True)
    parser.add_argument("--action", choices=sorted(ALLOWED))
    parser.add_argument("--target", type=int)
    args = parser.parse_args()
    host = None
    try:
        guard.require(args.command == "run" or (args.action is None and args.target is None), "INVALID_ARGUMENTS")
        host = Host(args.root, args.owner, args.artifact_sha, args.node_id, claim=args.command == "claim")
        if args.command == "run":
            result = host.run(args.action, args.target)
        elif args.command == "claim":
            result = {"claimed": True}
        else:
            guard.require(args.action is None and args.target is None, "INVALID_ARGUMENTS")
            result = getattr(host, args.command)()
        print(json.dumps({"schemaVersion": 1, "purpose": PURPOSE, "ok": True, **result}, separators=(",", ":")))
    except (guard.Refused, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        reason = str(error) if isinstance(error, guard.Refused) else "FIELD_HOST_REFUSED"
        print(json.dumps({"schemaVersion": 1, "purpose": PURPOSE, "ok": False, "reason": reason,
                          "workerFailure": host.worker_failure if host is not None else None}))
        return 2
    finally:
        if host is not None:
            host.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
