#!/usr/bin/env python3
"""Bounded, private comparison of two stopped core trees; never activation.

Linux/Unix only: holds the persistent WabiDB flock in both trees. Callers must
exclude old PID-lock binaries and independent sidecar/plugin writers themselves.
Reports contain no filenames, per-key hashes, contents, credentials or endpoints.
"""
import argparse
from contextlib import ExitStack
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time

RUNTIME = frozenset({"wabidb/.lock", ".wabi-secret-publication.lock",
                     "wabidb/.wabi-secret-publication.lock", "tailcat/addr.txt"})
LIVE_GUARDS = {
    "wabidb/writer-fenced-v1": b"fenced\n",
    "wabidb/live-checkpoint-v1":
        b"inactive live checkpoint; promotion requires a separate verified protocol\n",
}
SNAPSHOT = "wabidb/projections/snapshot.json"
JSON_LIMIT = 4 * 1024 * 1024
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


class Refused(Exception):
    """Only fixed, non-sensitive refusal codes cross the CLI boundary."""


@dataclass(frozen=True)
class Limits:
    entries: int = 25000
    file_bytes: int = 4 * 1024**3
    path_bytes: int = 1024 * 1024
    seconds: int = 120

    def validate(self):
        for value, ceiling in [(self.entries, 100000), (self.file_bytes, 16 * 1024**3),
                               (self.path_bytes, 16 * 1024**2), (self.seconds, 300)]:
            if type(value) is not int or not 0 < value <= ceiling:
                raise Refused("INVALID_LIMIT")


class Budget:
    def __init__(self, limits):
        limits.validate()
        self.limits = limits
        self.deadline = time.monotonic() + limits.seconds
        self.entries = self.file_bytes = self.path_bytes = 0

    def check(self):
        if time.monotonic() >= self.deadline:
            raise Refused("DEADLINE")

    def entry(self, name):
        self.check()
        self.entries += 1
        self.path_bytes += len(name.encode("utf-8", "strict"))
        if self.entries > self.limits.entries or self.path_bytes > self.limits.path_bytes:
            raise Refused("INVENTORY_LIMIT")

    def bytes(self, count):
        self.check()
        self.file_bytes += count
        if self.file_bytes > self.limits.file_bytes:
            raise Refused("BYTE_LIMIT")


def stable(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def no_duplicate_keys(pairs):
    record = {}
    for key, value in pairs:
        if key in record:
            raise Refused("INVALID_PROJECTION")
        record[key] = value
    return record


def projection(payload):
    try:
        record = json.loads(payload, object_pairs_hook=no_duplicate_keys)
        if not isinstance(record, dict) or set(record) != {"watermark", "indexes"}:
            raise Refused("INVALID_PROJECTION")
        seq, indexes = record["watermark"], record["indexes"]
        if type(seq) is not int or not 0 <= seq < 2**64 or not isinstance(indexes, list):
            raise Refused("INVALID_PROJECTION")
        names, normalized, count = set(), [], 0
        for pair in indexes:
            if not isinstance(pair, list) or len(pair) != 2:
                raise Refused("INVALID_PROJECTION")
            name, entries = pair
            if not isinstance(name, str) or not name or name in names or not isinstance(entries, list):
                raise Refused("INVALID_PROJECTION")
            names.add(name)
            keys, decoded = set(), []
            for entry in entries:
                if not isinstance(entry, dict) or set(entry) != {"key", "value"}:
                    raise Refused("INVALID_PROJECTION")
                values = []
                for field in ("key", "value"):
                    value = entry[field]
                    if not isinstance(value, str) or not re.fullmatch(r"(?:[0-9a-fA-F]{2})*", value):
                        raise Refused("INVALID_PROJECTION")
                    values.append(value.lower())
                if values[0] in keys:
                    raise Refused("INVALID_PROJECTION")
                keys.add(values[0])
                decoded.append(values)
                count += 1
                if count > 50000:
                    raise Refused("PROJECTION_LIMIT")
            normalized.append([name, sorted(decoded)])
        canonical = json.dumps([seq, sorted(normalized)], separators=(",", ":"),
                               ensure_ascii=True).encode()
        return {"watermark": seq, "indexes": len(names), "entries": count,
                "sha256": hashlib.sha256(canonical).hexdigest()}
    except (ValueError, TypeError, RecursionError):
        raise Refused("INVALID_PROJECTION") from None


def checked_root(value):
    path = Path(os.path.abspath(value))
    # Refuse symlinks in every component, not just the last component.
    for component in [*reversed(path.parents), path]:
        if not stat.S_ISDIR(component.lstat().st_mode):
            raise Refused("UNSAFE_ROOT")
    return path


def descendant(child, parent):
    return child == parent or parent in child.parents


def open_directory(stack, path):
    fd = os.open(path, DIRECTORY_FLAGS)
    stack.callback(os.close, fd)
    return fd


def lock_engine(stack, data):
    if (data / ".lock").exists() or (data / ".lock").is_symlink():
        raise Refused("LEGACY_LOCK")
    engine = open_directory(stack, data / "wabidb")
    fd = os.open(".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                 0o600, dir_fd=engine)
    stack.callback(os.close, fd)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise Refused("UNSAFE_LOCK")
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise Refused("WRITER_ACTIVE") from None
    # Do not truncate, write PID text, or unlink this shared persistent inode.
    return engine, fd, (info.st_dev, info.st_ino)


def inventory(stack, data, uploads, budget, inactive):
    items, snapshot, key_valid = {}, None, False
    root_fd = open_directory(stack, data)
    upload_relative = uploads.relative_to(data).as_posix() if descendant(uploads, data) else None

    def walk(fd, prefix, data_tree, depth=0):
        nonlocal snapshot, key_valid
        budget.check()
        if depth > 64:
            raise Refused("DEPTH_LIMIT")
        before = os.fstat(fd)
        entries = []
        with os.scandir(fd) as stream:
            for entry in stream:
                relative = f"{prefix}/{entry.name}" if prefix else entry.name
                budget.entry(relative)
                entries.append((entry.name, relative))
        for name, relative in sorted(entries):
            budget.check()
            seen = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(seen.st_mode):
                child = os.open(name, DIRECTORY_FLAGS, dir_fd=fd)
                try:
                    if stable(seen) != stable(os.fstat(child)):
                        raise Refused("TREE_CHANGED")
                    # Embedded uploads are represented only in the uploads namespace.
                    if data_tree and relative == upload_relative:
                        walk(child, "", False, depth + 1)
                    else:
                        items[("data" if data_tree else "uploads", relative)] = ("directory",)
                        walk(child, relative, data_tree, depth + 1)
                finally:
                    os.close(child)
            elif stat.S_ISREG(seen.st_mode) and seen.st_nlink == 1:
                handle = os.open(name, FILE_FLAGS, dir_fd=fd)
                try:
                    if stable(seen) != stable(os.fstat(handle)):
                        raise Refused("TREE_CHANGED")
                    if data_tree and relative in RUNTIME:
                        continue
                    guard = inactive and data_tree and relative in LIVE_GUARDS
                    collect = data_tree and relative in {SNAPSHOT, "wabidb/root_key"}
                    limit = JSON_LIMIT if relative == SNAPSHOT else 256
                    if (collect and seen.st_size > limit) or (guard and seen.st_size > 256):
                        raise Refused("PROJECTION_LIMIT" if relative == SNAPSHOT else "INVALID_KEY_OR_GUARD")
                    digest, payload, size = hashlib.sha256(), bytearray(), 0
                    while True:
                        chunk = os.read(handle, 65536)
                        if not chunk:
                            break
                        budget.bytes(len(chunk))
                        digest.update(chunk)
                        size += len(chunk)
                        if collect or guard:
                            payload.extend(chunk)
                            if len(payload) > limit:
                                raise Refused("TREE_CHANGED")
                    if stable(seen) != stable(os.fstat(handle)) or size != seen.st_size:
                        raise Refused("TREE_CHANGED")
                    if guard:
                        if bytes(payload) != LIVE_GUARDS[relative]:
                            raise Refused("INVALID_INACTIVE_GUARD")
                        continue
                    items[("data" if data_tree else "uploads", relative)] = (
                        "file", size, digest.hexdigest())
                    if data_tree and relative == SNAPSHOT:
                        snapshot = projection(payload)
                    if data_tree and relative == "wabidb/root_key":
                        key_valid = bool(re.fullmatch(rb"[0-9a-fA-F]{64}", payload.strip()))
                finally:
                    os.close(handle)
            else:
                raise Refused("UNSUPPORTED_ENTRY")
        if stable(before) != stable(os.fstat(fd)):
            raise Refused("TREE_CHANGED")

    walk(root_fd, "", True)
    if upload_relative is None:
        walk(open_directory(stack, uploads), "", False)
    jwt = items.get(("data", "jwt_secret"))
    if snapshot is None or not key_valid or not jwt or jwt[0] != "file" or jwt[1] == 0:
        raise Refused("MISSING_CORE_MATERIAL")
    if inactive:
        # The walk validates content; this additionally requires both guards.
        for relative in LIVE_GUARDS:
            if not (data / relative).is_file():
                raise Refused("MISSING_INACTIVE_GUARD")
    return items, snapshot


def compare(left_data, left_uploads, right_data, right_uploads, *, inactive=False, limits=Limits()):
    budget = Budget(limits)
    roots = [checked_root(p) for p in (left_data, left_uploads, right_data, right_uploads)]
    ld, lu, rd, ru = roots
    if descendant(ld, lu) or descendant(rd, ru):
        raise Refused("OVERLAPPING_ROOTS")
    for left in (ld, lu):
        for right in (rd, ru):
            if descendant(left, right) or descendant(right, left):
                raise Refused("OVERLAPPING_ROOTS")
    root_inodes = [(p.stat().st_dev, p.stat().st_ino) for p in roots]
    if len(set(root_inodes)) != 4:
        raise Refused("ALIASED_ROOTS")
    with ExitStack() as stack:
        locks = [lock_engine(stack, data) for data in (ld, rd)]
        def verify_locks():
            for data, (engine, fd, inode) in zip((ld, rd), locks):
                actual = (data / "wabidb").lstat()
                owned = os.fstat(engine)
                info = os.stat(".lock", dir_fd=engine, follow_symlinks=False)
                if ((actual.st_dev, actual.st_ino) != (owned.st_dev, owned.st_ino)
                        or (info.st_dev, info.st_ino) != inode or os.fstat(fd).st_nlink != 1):
                    raise Refused("LOCK_CHANGED")
        verify_locks()
        li, lp = inventory(stack, ld, lu, budget, False)
        ri, rp = inventory(stack, rd, ru, budget, inactive)
        verify_locks()
        if root_inodes != [(p.stat().st_dev, p.stat().st_ino) for p in roots]:
            raise Refused("TREE_CHANGED")
        left_only, right_only = li.keys() - ri.keys(), ri.keys() - li.keys()
        changed = sum(li[key] != ri[key] for key in li.keys() & ri.keys())
        equal = not left_only and not right_only and not changed and lp == rp
        return {"schemaVersion": 1, "result": "PASS" if equal else "FAIL",
                "scope": "stopped core filesystem comparison only",
                "leftOnlyEntries": len(left_only), "rightOnlyEntries": len(right_only),
                "changedEntries": changed, "leftEntries": len(li), "rightEntries": len(ri),
                "projectionMatch": lp == rp, "projection": lp if lp == rp else None,
                "inactiveGuardsChecked": inactive, "scannedFileBytes": budget.file_bytes,
                "engineReplayTested": False, "externalStateVerified": False,
                "fullInstanceReady": False, "authorityRecoveryTested": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("left-data", "left-uploads", "right-data", "right-uploads"):
        parser.add_argument("--" + flag, required=True)
    parser.add_argument("--inactive-live", action="store_true")
    parser.add_argument("--max-entries", type=int, default=Limits.entries)
    parser.add_argument("--max-bytes", type=int, default=Limits.file_bytes)
    parser.add_argument("--max-path-bytes", type=int, default=Limits.path_bytes)
    parser.add_argument("--deadline-seconds", type=int, default=Limits.seconds)
    args = parser.parse_args()
    try:
        result = compare(args.left_data, args.left_uploads, args.right_data, args.right_uploads,
                         inactive=args.inactive_live, limits=Limits(
                             args.max_entries, args.max_bytes, args.max_path_bytes, args.deadline_seconds))
    except Refused as error:
        result = {"schemaVersion": 1, "result": "REFUSED", "reason": str(error),
                  "fullInstanceReady": False}
    except (OSError, ValueError, RecursionError, MemoryError):
        result = {"schemaVersion": 1, "result": "REFUSED", "reason": "FILESYSTEM_OR_RESOURCE_ERROR",
                  "fullInstanceReady": False}
    print(json.dumps(result, sort_keys=True))
    return 0 if result["result"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
