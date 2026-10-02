#!/usr/bin/env python3
"""Bounded local control of an already supervised disposable recovery worker.

No key generation, networking setup, process launch, Authority or HA permit.
Synthetic tests do not certify the pending Rust/Noise/Raft worker protocol.
"""
import argparse
import dataclasses
import fcntl
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import socket
import stat
import struct
import sys

SUPERVISOR = Path(__file__).with_name("rpc-probe-supervisor.py")
spec = importlib.util.spec_from_file_location("rpc_probe_guard", SUPERVISOR)
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
Refused = guard.Refused
require = guard.require
MAX_FRAME = 4096
MAX_REQUESTS = 128
U64 = 2**64 - 1
COMMAND_FIELDS = ("operationId", "partitionId", "expectedEpoch", "proposedWriter",
                  "checkpointInventorySha256")
REPLY_FIELDS = {"result", "nodeId", "isLeader", "currentTerm", "leaderHint",
                "durableAppliedIndex", "observedSnapshotIndex", "observedPurgedIndex",
                "operationsSha256", "epoch", "operations", "minorityOperationPresent",
                "control", "canonicalWriterPermitted"}


class Indeterminate(Exception):
    """Mutation may have reached the worker; never automatically retry."""


def uint(value, maximum=U64):
    return type(value) is int and 0 <= value <= maximum


def encoded(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()


def decode(body):
    require(0 < len(body) <= MAX_FRAME, "FRAME_LIMIT")
    value = json.loads(body, object_pairs_hook=guard.no_duplicates,
                       parse_constant=lambda _: (_ for _ in ()).throw(Refused("INVALID_RECORD")))
    require(isinstance(value, dict), "INVALID_RECORD")
    return value


@dataclasses.dataclass(frozen=True)
class Intent:
    # Owned serialized bytes prevent a caller changing a dict after submission.
    body: bytes
    sha256: str

    @classmethod
    def from_command(cls, command):
        require(isinstance(command, dict) and set(command) == set(COMMAND_FIELDS), "INVALID_COMMAND")
        op = command["operationId"]
        partition = command["partitionId"]
        require(isinstance(op, str) and len(op) == 32
                and all(c in "0123456789abcdef" for c in op), "INVALID_OPERATION")
        require(isinstance(partition, str) and 0 < len(partition) <= 128
                and all(c.isascii() and (c.isalnum() or c in "_-:/") for c in partition),
                "INVALID_PARTITION")
        require(uint(command["expectedEpoch"], U64 - 1)
                and uint(command["proposedWriter"]) and command["proposedWriter"] > 0
                and guard.hex64(command["checkpointInventorySha256"]), "INVALID_COMMAND")
        # This versioned order matches the pinned Rust ControlCommand fields.
        # Actual Rust/Python codec compatibility remains an executable gate.
        body = encoded({key: command[key] for key in COMMAND_FIELDS})
        require(len(body) <= MAX_FRAME, "FRAME_LIMIT")
        return cls(body, hashlib.sha256(body).hexdigest())

    @property
    def command(self):
        return decode(self.body)


@dataclasses.dataclass(frozen=True)
class Observation:
    request: bytes
    reply: bytes

    @property
    def value(self):
        return decode(self.reply)


class Lease:
    """Caller-owned nonblocking pipe; no queue, daemon or lifetime renewal."""
    def __init__(self, writer):
        require(stat.S_ISFIFO(os.fstat(writer).st_mode), "INVALID_CONTROLLER_PIPE")
        flags = fcntl.fcntl(writer, fcntl.F_GETFL)
        require(flags & os.O_NONBLOCK and flags & os.O_ACCMODE == os.O_WRONLY,
                "INVALID_CONTROLLER_PIPE")
        self.writer = os.dup(writer)
        self.pulses = self.restarts = 0
        self.last = None

    def close(self):
        if self.writer is not None:
            os.close(self.writer)
            self.writer = None

    def send(self, frame):
        require(self.writer is not None, "CONTROLLER_CLOSED")
        require(frame in (b"keepalive\n", b"restart\n", b"stop\n"), "CONTROLLER_PROTOCOL")
        require(os.write(self.writer, frame) == len(frame), "CONTROLLER_WRITE")

    def keepalive(self):
        now = guard.boot_now()
        if self.last is None or now - self.last >= 1:
            require(self.pulses < 128, "CONTROLLER_LIMIT")
            self.send(b"keepalive\n")
            self.last = now
            self.pulses += 1

    def restart(self):
        require(self.restarts < guard.MAX_RESTARTS, "RESTART_LIMIT")
        self.send(b"restart\n")
        self.restarts += 1

    def stop(self):
        self.send(b"stop\n")


def validate_reply(reply, node_id, peers):
    require(set(reply) in (REPLY_FIELDS, REPLY_FIELDS | {"controlCommandSha256"}), "INVALID_REPLY")
    require(type(reply["nodeId"]) is int and reply["nodeId"] == node_id
            and type(reply["isLeader"]) is bool and uint(reply["currentTerm"])
            and type(reply["minorityOperationPresent"]) is bool
            and reply["canonicalWriterPermitted"] is False, "INVALID_REPLY")
    require(reply["leaderHint"] is None or
            type(reply["leaderHint"]) is int and reply["leaderHint"] in peers, "INVALID_REPLY")
    for key in ("durableAppliedIndex", "observedSnapshotIndex", "observedPurgedIndex"):
        require(reply[key] is None or uint(reply[key]), "INVALID_REPLY")
    require(guard.hex64(reply["operationsSha256"]) and uint(reply["epoch"])
            and uint(reply["operations"], 16384), "INVALID_REPLY")
    require(isinstance(reply["result"], str) and reply["result"] in {"status", "receipt", "initialized", "committed",
                                "refused", "indeterminate", "stopped"}, "INVALID_REPLY")
    require(reply.get("controlCommandSha256") is None
            or guard.hex64(reply["controlCommandSha256"]), "INVALID_REPLY")
    control = reply["control"]
    if control is None:
        return
    require(isinstance(control, dict) and set(control) ==
            {"outcome", "epoch", "committedAt", "canonicalWriterPermitted"}, "INVALID_CONTROL")
    require(isinstance(control["outcome"], str) and control["outcome"] in {"accepted", "conflict", "refused"}
            and uint(control["epoch"]) and control["canonicalWriterPermitted"] is False,
            "INVALID_CONTROL")
    position = control["committedAt"]
    if position is not None:
        require(isinstance(position, dict) and set(position) == {"leader_id", "index"}
                and uint(position["index"]), "INVALID_POSITION")
        leader = position["leader_id"]
        require(isinstance(leader, dict) and set(leader) == {"term", "node_id"}
                and uint(leader["term"]) and type(leader["node_id"]) is int
                and leader["node_id"] in peers, "INVALID_POSITION")


class Client:
    def __init__(self, root, owner, artifact_sha256, config_sha256, node_id, *,
                 peers=(1, 2, 3), lease=None, _allow_synthetic=False):
        require(guard.hex64(owner) and guard.hex64(artifact_sha256)
                and guard.hex64(config_sha256), "INVALID_BINDING")
        require(len(peers) == 3 and len(set(peers)) == 3
                and all(uint(n) and n > 0 for n in peers)
                and type(node_id) is int and node_id in peers, "INVALID_BINDING")
        require(type(_allow_synthetic) is bool, "INVALID_BINDING")
        self.path, self.owner = str(root), owner
        self.artifact_sha, self.config_sha = artifact_sha256, config_sha256
        self.node_id, self.peers = node_id, tuple(peers)
        self.lease, self.synthetic = lease, _allow_synthetic
        self.requests = 0

    def request(self, action, *, intent=None, timeout=5):
        require(sys.platform == "linux" and hasattr(socket, "SO_PEERCRED"), "PLATFORM_UNSUPPORTED")
        require(type(timeout) in (int, float) and math.isfinite(timeout)
                and 0.05 <= timeout <= 5, "INVALID_DEADLINE")
        require(action in {"status", "receipt", "initialize", "propose", "stop"}, "INVALID_ACTION")
        require(self.requests < MAX_REQUESTS, "REQUEST_LIMIT")
        request = {"action": action}
        if action in {"propose", "receipt"}:
            require(isinstance(intent, Intent), "MISSING_ORIGINAL_INTENT")
            require(Intent.from_command(intent.command) == intent, "INTENT_CHANGED")
            if action == "propose":
                request["command"] = intent.command
            else:
                request["operation_id"] = intent.command["operationId"]
        else:
            require(intent is None, "INVALID_ARGUMENTS")
        body = encoded(request)
        require(len(body) <= MAX_FRAME, "FRAME_LIMIT")
        self.requests += 1
        deadline = guard.boot_now() + timeout
        descriptors = []
        mutation_sent = False
        try:
            path, root = guard.root_fd(self.path)
            descriptors.append(root)
            record = guard.read_json(root, guard.MARKER, 4096)
            require(set(record) == {"schemaVersion", "purpose", "owner", "nodeId", "root", "lock",
                                    "artifactSha256", "artifact", "synthetic", "child"}
                    and type(record.get("schemaVersion")) is int and record["schemaVersion"] == 1
                    and record.get("purpose") == guard.PURPOSE
                    and record.get("owner") == self.owner and type(record.get("nodeId")) is int
                    and record["nodeId"] == self.node_id
                    and record.get("root") == guard.identity(os.fstat(root))
                    and type(record.get("synthetic")) is bool
                    and (not record["synthetic"] or self.synthetic), "OWNERSHIP_CHANGED")
            artifact, stamp = guard.check_artifact(root, self.artifact_sha)
            descriptors.append(artifact)
            require(record.get("artifactSha256") == self.artifact_sha
                    and record.get("artifact") == stamp, "ARTIFACT_CHANGED")
            lock = guard.file_fd(root, guard.LOCK)
            descriptors.append(lock)
            require(record.get("lock") == guard.identity(os.fstat(lock)), "LOCK_SUBSTITUTED")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                pass
            else:
                raise Refused("SUPERVISOR_NOT_ACTIVE")
            config_fd = guard.file_fd(root, "fixture.json")
            descriptors.append(config_fd)
            before = guard.stamp(os.fstat(config_fd))
            require(before[2] <= 16384, "CONFIG_LIMIT")
            config_body = os.read(config_fd, 16385)
            require(0 < len(config_body) <= 16384 and before == guard.stamp(os.fstat(config_fd))
                    and hashlib.sha256(config_body).hexdigest() == self.config_sha, "CONFIG_CHANGED")
            config = json.loads(config_body, object_pairs_hook=guard.no_duplicates)
            require(isinstance(config, dict) and config.get("owner") == self.owner
                    and isinstance(config.get("binding"), dict)
                    and type(config["binding"].get("nodeId")) is int
                    and config["binding"]["nodeId"] == self.node_id
                    and isinstance(config.get("peers"), dict)
                    and set(config["peers"]) == {str(n) for n in self.peers}, "CONFIG_CHANGED")
            saved = record.get("child")
            require(isinstance(saved, dict) and guard.live_matches(saved, guard.process_identity(saved.get("pid"))),
                    "WORKER_NOT_LIVE")
            require(guard.identity(os.stat(f"/proc/{saved['pid']}/exe")) == stamp[:2], "WORKER_CHANGED")
            endpoint = path / "control.sock"
            endpoint_stamp = endpoint.lstat()
            guard.private(endpoint_stamp)
            require(stat.S_ISSOCK(endpoint_stamp.st_mode), "INVALID_SOCKET")
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
                stream.settimeout(max(0.001, deadline - guard.boot_now()))
                stream.connect(str(endpoint))
                pid, uid, _ = struct.unpack("3i", stream.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                require(pid == saved["pid"] and uid == os.getuid()
                        and guard.live_matches(saved, guard.process_identity(pid))
                        and guard.identity(os.stat(f"/proc/{pid}/exe")) == stamp[:2]
                        and guard.identity(path.lstat()) == record["root"]
                        and guard.identity(endpoint.lstat()) == guard.identity(endpoint_stamp)
                        and guard.read_json(root, guard.MARKER, 4096) == record, "WORKER_CHANGED")
                if self.lease:
                    self.lease.keepalive()
                require(guard.boot_now() < deadline, "REQUEST_DEADLINE")
                mutation_sent = action in {"propose", "initialize", "stop"}
                stream.sendall(struct.pack("!I", len(body)) + body)
                def read_exact(size):
                    result = bytearray()
                    while len(result) < size:
                        remaining = deadline - guard.boot_now()
                        require(remaining > 0, "REPLY_DEADLINE")
                        if self.lease:
                            self.lease.keepalive()
                        stream.settimeout(min(0.25, remaining))
                        try:
                            part = stream.recv(size - len(result))
                        except socket.timeout:
                            continue
                        require(bool(part), "REPLY_UNAVAILABLE")
                        result.extend(part)
                    return bytes(result)
                length = struct.unpack("!I", read_exact(4))[0]
                require(0 < length <= MAX_FRAME, "FRAME_LIMIT")
                reply = decode(read_exact(length))
                validate_reply(reply, self.node_id, self.peers)
                if intent is not None and reply["control"] is not None:
                    # Epoch/log/outcome alone cannot prove the exact original
                    # proposal. Require the persisted-command fingerprint.
                    require(reply.get("controlCommandSha256") == intent.sha256, "UNBOUND_RECEIPT")
                outcomes = {"status": {"status"}, "receipt": {"receipt", "refused"},
                            "initialize": {"initialized", "refused", "indeterminate"},
                            "propose": {"committed", "refused", "indeterminate"}, "stop": {"stopped"}}
                require(reply["result"] in outcomes[action], "INVALID_REPLY")
                require(action != "status" or reply["control"] is None, "INVALID_REPLY")
                require(reply["result"] != "committed" or reply["control"] is not None, "INVALID_REPLY")
                return Observation(body, encoded(reply))
        except (Refused, OSError, ValueError, TypeError, KeyError, RecursionError):
            if mutation_sent:
                raise Indeterminate("original_operation_receipt_required") from None
            raise Refused("probe_control_refused") from None
        finally:
            for fd in reversed(descriptors):
                os.close(fd)


def accepted_receipt(observation, intent, peers=(1, 2, 3)):
    reply = observation.value
    validate_reply(reply, reply.get("nodeId"), peers)
    require(Intent.from_command(intent.command) == intent, "INTENT_CHANGED")
    request = decode(observation.request)
    require(request == {"action": "receipt", "operation_id": intent.command["operationId"]},
            "WRONG_ORIGINAL_OPERATION")
    require(reply["result"] == "receipt" and reply.get("controlCommandSha256") == intent.sha256,
            "UNBOUND_RECEIPT")
    control = reply["control"]
    require(isinstance(control, dict) and control["outcome"] == "accepted"
            and control["epoch"] == intent.command["expectedEpoch"] + 1
            and control["committedAt"] is not None
            and reply["durableAppliedIndex"] is not None
            and reply["durableAppliedIndex"] >= control["committedAt"]["index"], "NOT_DURABLY_ACCEPTED")
    return control


def convergence(observations, intent, peers=(1, 2, 3)):
    require(len(peers) == 3 and len(set(peers)) == 3 and all(uint(n) and n > 0 for n in peers),
            "INVALID_BINDING")
    require(Intent.from_command(intent.command) == intent, "INTENT_CHANGED")
    for observation in observations:
        validate_reply(observation.value, observation.value.get("nodeId"), peers)
    require(len(observations) == 3 and {o.value["nodeId"] for o in observations} == set(peers),
            "INCOMPLETE_VOTERS")
    receipts = [accepted_receipt(o, intent, peers) for o in observations]
    require(all(c == receipts[0] for c in receipts), "RECEIPTS_DIVERGED")
    states = [(o.value["operationsSha256"], o.value["operations"], o.value["epoch"]) for o in observations]
    require(all(s == states[0] for s in states), "STATES_DIVERGED")
    return {"result": "PASS", "scope": "exact_disposable_control_receipt_convergence",
            "voters": 3, "canonicalWriterPermitted": False,
            "automaticWabiRecoveryTested": False, "physicalThreeSiteTested": False}


class RedactedParser(argparse.ArgumentParser):
    def error(self, _message):
        print(json.dumps({"result": "REFUSED", "reason": "probe_control_refused",
                          "automaticWabiRecoveryTested": False}))
        raise SystemExit(2)


def main():
    parser = RedactedParser(description=__doc__)
    parser.add_argument("action", choices=("status", "receipt", "initialize", "propose", "stop"))
    for name in ("root", "owner", "artifact-sha256", "config-sha256"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--node-id", required=True, type=int)
    args = parser.parse_args()
    try:
        intent = None
        if args.action in {"receipt", "propose"}:
            intent = Intent.from_command(decode(sys.stdin.buffer.read(MAX_FRAME + 1)))
        client = Client(args.root, args.owner, args.artifact_sha256, args.config_sha256, args.node_id)
        observation = client.request(args.action, intent=intent)
        print(json.dumps({"result": "OBSERVED", "scope": "disposable_control_only",
                          "reply": observation.value, "automaticWabiRecoveryTested": False}))
        return 0
    except Indeterminate:
        print(json.dumps({"result": "INDETERMINATE", "reason": "probe_outcome_unresolved",
                          "needsOriginalOperationReceipt": args.action == "propose",
                          "automaticWabiRecoveryTested": False}))
        return 3
    except (Refused, OSError, ValueError, TypeError, KeyError, RecursionError):
        print(json.dumps({"result": "REFUSED", "reason": "probe_control_refused",
                          "automaticWabiRecoveryTested": False}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
