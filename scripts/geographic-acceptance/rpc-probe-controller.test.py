"""Synthetic private Unix peer tests. No Rust, Noise, Raft, keys or TCP."""
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).with_name("rpc-probe-controller.py")
spec = importlib.util.spec_from_file_location("rpc_controller", SCRIPT)
ctl = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ctl
spec.loader.exec_module(ctl)
guard = ctl.guard
OWNER = "ab" * 32
COMMAND = {"operationId": "0" * 31 + "1", "partitionId": "room:fixture", "expectedEpoch": 0,
           "proposedWriter": 1, "checkpointInventorySha256": "ab" * 32}
CONTROL = {"outcome": "accepted", "epoch": 1,
           "committedAt": {"leader_id": {"term": 2, "node_id": 1}, "index": 7},
           "canonicalWriterPermitted": False}
BASE = {"result": "receipt", "nodeId": 1, "isLeader": True, "currentTerm": 2, "leaderHint": 1,
        "durableAppliedIndex": 7, "observedSnapshotIndex": None, "observedPurgedIndex": None,
        "operationsSha256": "cd" * 32, "epoch": 1, "operations": 1,
        "minorityOperationPresent": False, "control": CONTROL,
        "controlCommandSha256": ctl.Intent.from_command(COMMAND).sha256, "canonicalWriterPermitted": False}
WORKER = r'''
import hashlib,json,os,socket,struct,sys,time
from pathlib import Path
root=Path(os.environ["WABI_RPC_FIXTURE_ROOT"])
base=json.loads(sys.argv[1]);mode=sys.argv[2];saved=None
endpoint=root/"control.sock"
server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);server.bind(str(endpoint));endpoint.chmod(0o600)
server.listen(1)
def exact(stream,n):
    body=b""
    while len(body)<n:
        part=stream.recv(n-len(body))
        if not part: return None
        body+=part
    return body
def digest(command):
    fields=("operationId","partitionId","expectedEpoch","proposedWriter","checkpointInventorySha256")
    body=json.dumps({k:command[k] for k in fields},separators=(",",":"),ensure_ascii=True).encode()
    return hashlib.sha256(body).hexdigest()
for _ in range(160):
    stream,_=server.accept()
    with stream:
        header=exact(stream,4)
        if header is None: continue
        size=struct.unpack("!I",header)[0]
        if not 0<size<=4096: break
        request=json.loads(exact(stream,size));reply=json.loads(json.dumps(base))
        action=request["action"]
        if action=="propose":
            reply["result"]="committed"
            if saved is None: saved=request["command"]
            if saved!=request["command"]: reply["control"]["outcome"]="refused"
            reply["controlCommandSha256"]=digest(saved)
            if mode=="lost_proposal": continue
        elif action=="status":
            reply["result"]="status";reply["control"]=None;reply["controlCommandSha256"]=None
        elif action=="receipt":
            reply["result"]="receipt"
            if saved is not None: reply["controlCommandSha256"]=digest(saved)
        elif action=="initialize":
            reply["result"]="initialized";reply["control"]=None;reply["controlCommandSha256"]=None
        elif action=="stop":
            reply["result"]="stopped";reply["control"]=None;reply["controlCommandSha256"]=None
        if mode=="legacy": reply.pop("controlCommandSha256")
        if mode=="wrong_node": reply["nodeId"]=2
        if mode=="permit": reply["canonicalWriterPermitted"]=True
        if mode=="boolean_index": reply["durableAppliedIndex"]=True
        if mode=="unknown": reply["unknown"]=1
        if mode=="oversize":
            stream.sendall(struct.pack("!I",2**32-1));continue
        if mode=="delay": time.sleep(1.2)
        if mode=="timeout": time.sleep(0.3)
        body=json.dumps(reply,separators=(",",":")).encode()
        if mode=="duplicate": body=b'{"result":"status","result":"refused"}'
        packet=struct.pack("!I",len(body))+body
        try:
            if mode=="fragment":
                for byte in packet: stream.sendall(bytes([byte]))
            else: stream.sendall(packet)
        except BrokenPipeError: pass
'''


@unittest.skipUnless(sys.platform == "linux" and hasattr(socket, "SO_PEERCRED"), "Linux peer credentials")
class ControllerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wabi-rpc-controller-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "node"
        self.root.mkdir(mode=0o700)
        artifact = self.root / guard.ARTIFACT
        shutil.copyfile(os.path.realpath(sys.executable), artifact)
        artifact.chmod(0o700)
        self.sha = hashlib.sha256(artifact.read_bytes()).hexdigest()
        self.session = guard.Session(str(self.root), OWNER, self.sha, 1, claim=True, synthetic=True)
        self.addCleanup(self.session.close)
        self.addCleanup(self.session.stop)
        self.config = {"owner": OWNER, "binding": {"nodeId": 1}, "peers": {str(n): {} for n in (1, 2, 3)}}
        body = ctl.encoded(self.config)
        path = self.root / "fixture.json"
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(body)
        self.config_sha = hashlib.sha256(body).hexdigest()
        self.intent = ctl.Intent.from_command(COMMAND)

    def client(self, **kwargs):
        return ctl.Client(str(self.root), OWNER, self.sha, self.config_sha, 1,
                          _allow_synthetic=True, **kwargs)

    def worker(self, mode="normal"):
        self.session.start(_worker_args=("-c", WORKER, json.dumps(BASE), mode))
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and not (self.root / "control.sock").exists():
            self.assertIsNone(self.session.child.poll())
            time.sleep(0.01)
        self.assertTrue((self.root / "control.sock").exists())

    def test_intent_is_immutable_and_matches_staged_rust_golden(self):
        value = copy.deepcopy(COMMAND)
        intent = ctl.Intent.from_command(value)
        value["proposedWriter"] = 2
        self.assertEqual(intent.command, COMMAND)
        self.assertEqual(intent.sha256, "5c7ee9597c941f9f8cf1b3eb1400f815242cbbbc27824b86f2510b116f0f5b3a")
        self.assertNotEqual(intent.sha256, ctl.Intent.from_command(value).sha256)

    def test_private_pinned_worker_fragmented_status_and_receipt(self):
        self.worker("fragment")
        client = self.client()
        status = client.request("status").value
        self.assertEqual(status["nodeId"], 1)
        self.assertIsNone(status["control"])
        observed = client.request("receipt", intent=self.intent)
        self.assertEqual(ctl.accepted_receipt(observed, self.intent), CONTROL)
        self.assertIsNone(self.session.child.poll())

    def test_lost_proposal_is_indeterminate_and_original_receipt_is_bound(self):
        self.worker("lost_proposal")
        client = self.client()
        with self.assertRaises(ctl.Indeterminate):
            client.request("propose", intent=self.intent)
        observed = client.request("receipt", intent=self.intent)
        self.assertEqual(ctl.accepted_receipt(observed, self.intent), CONTROL)
        changed = copy.deepcopy(COMMAND)
        changed["proposedWriter"] = 2
        with self.assertRaises(ctl.Refused):
            client.request("receipt", intent=ctl.Intent.from_command(changed))
        # No automatic resend and no changed operation under the original ID.
        self.assertEqual(client.requests, 3)

    def test_missing_command_binding_is_never_resolved_by_epoch_and_log(self):
        self.worker("legacy")
        client = self.client()
        with self.assertRaises(ctl.Refused):
            client.request("receipt", intent=self.intent)
        with self.assertRaises(ctl.Indeterminate):
            client.request("propose", intent=self.intent)

    def test_same_id_changed_proposal_returns_actual_stored_fingerprint(self):
        self.worker()
        client = self.client()
        self.assertEqual(client.request("propose", intent=self.intent).value["control"], CONTROL)
        changed = copy.deepcopy(COMMAND)
        changed["checkpointInventorySha256"] = "ef" * 32
        with self.assertRaises(ctl.Indeterminate):
            client.request("propose", intent=ctl.Intent.from_command(changed))
        self.assertEqual(ctl.accepted_receipt(client.request("receipt", intent=self.intent), self.intent), CONTROL)

    def test_oversize_response_is_refused_before_body_read(self):
        self.worker("oversize")
        with self.assertRaises(ctl.Refused):
            self.client().request("status")

    def test_duplicate_response_fields_refuse(self):
        self.worker("duplicate")
        with self.assertRaises(ctl.Refused):
            self.client().request("status")

    def test_wrong_logical_node_refuses(self):
        self.worker("wrong_node")
        with self.assertRaises(ctl.Refused):
            self.client().request("status")

    def test_writer_permit_claim_refuses(self):
        self.worker("permit")
        with self.assertRaises(ctl.Refused):
            self.client().request("status")

    def test_boolean_integer_and_unknown_reply_fields_refuse(self):
        for mode in ("boolean_index", "unknown"):
            with self.subTest(mode=mode):
                reply = copy.deepcopy(BASE)
                if mode == "boolean_index": reply["durableAppliedIndex"] = True
                else: reply["unknown"] = 1
                with self.assertRaises(ctl.Refused):
                    ctl.validate_reply(reply, 1, (1, 2, 3))

    def test_reply_timeout_is_bounded_and_proposal_is_indeterminate(self):
        self.worker("timeout")
        started = time.monotonic()
        with self.assertRaises(ctl.Indeterminate):
            self.client().request("propose", intent=self.intent, timeout=0.05)
        self.assertLess(time.monotonic() - started, 1)

    def test_lease_pulses_during_stalled_reply_and_never_queues(self):
        self.worker("delay")
        reader, writer = os.pipe2(os.O_NONBLOCK)
        self.addCleanup(os.close, reader)
        self.addCleanup(os.close, writer)
        lease = ctl.Lease(writer)
        self.addCleanup(lease.close)
        self.client(lease=lease).request("status", timeout=2)
        self.assertEqual(os.read(reader, 1024), b"keepalive\nkeepalive\n")
        for _ in range(guard.MAX_RESTARTS): lease.restart()
        with self.assertRaises(ctl.Refused): lease.restart()
        lease.stop()
        self.assertEqual(os.read(reader, 1024), b"restart\n" * 8 + b"stop\n")

    def test_full_controller_pipe_refuses_without_blocking(self):
        reader, writer = os.pipe2(os.O_NONBLOCK)
        self.addCleanup(os.close, reader)
        self.addCleanup(os.close, writer)
        while True:
            try: os.write(writer, b"x" * 4096)
            except BlockingIOError: break
        lease = ctl.Lease(writer)
        self.addCleanup(lease.close)
        started = time.monotonic()
        with self.assertRaises(BlockingIOError): lease.keepalive()
        self.assertLess(time.monotonic() - started, 0.5)

    def test_blocking_controller_pipe_refuses_without_changing_flags(self):
        reader, writer = os.pipe()
        self.addCleanup(os.close, reader)
        self.addCleanup(os.close, writer)
        before = fcntl.fcntl(writer, fcntl.F_GETFL)
        with self.assertRaises(ctl.Refused): ctl.Lease(writer)
        self.assertEqual(before, fcntl.fcntl(writer, fcntl.F_GETFL))

    def test_inactive_supervisor_refuses_before_control_connect(self):
        self.worker()
        fcntl.flock(self.session.lock, fcntl.LOCK_UN)
        with self.assertRaises(ctl.Refused): self.client().request("status")

    def test_config_and_marker_substitution_refuse(self):
        self.worker()
        original = (self.root / "fixture.json").read_bytes()
        (self.root / "fixture.json").write_bytes(original + b" ")
        with self.assertRaises(ctl.Refused): self.client().request("status")
        (self.root / "fixture.json").write_bytes(original)
        guard.write_marker(self.session.root, dict(self.session.record, owner="cd" * 32))
        with self.assertRaises(ctl.Refused): self.client().request("status")

    def test_foreign_socket_peer_refuses_without_request_or_signal(self):
        self.worker()
        # Same frozen executable; only SO_PEERCRED distinguishes this process
        # from the recorded worker that actually owns the Unix listener.
        unrelated = subprocess.Popen([str(self.root / guard.ARTIFACT), "-c", "import time;time.sleep(30)"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            changed = dict(self.session.record, child=guard.process_identity(unrelated.pid))
            guard.write_marker(self.session.root, changed)
            with self.assertRaises(ctl.Refused): self.client().request("status")
            self.assertIsNone(unrelated.poll())
        finally:
            unrelated.terminate(); unrelated.wait(timeout=3)
            guard.write_marker(self.session.root, self.session.record)

    def test_invalid_request_limits_refuse_before_any_connection(self):
        client = self.client()
        for timeout in (True, 0, 6, float("nan"), float("inf")):
            with self.assertRaises(ctl.Refused): client.request("status", timeout=timeout)
        with self.assertRaises(ctl.Refused): client.request("propose")
        with self.assertRaises(ctl.Refused): client.request("forward-port")
        self.assertEqual(client.requests, 0)
        client.requests = ctl.MAX_REQUESTS
        with self.assertRaises(ctl.Refused): client.request("status")

    def test_structured_invalid_result_and_control_outcome_refuse(self):
        for field in ("result", "outcome"):
            reply = copy.deepcopy(BASE)
            if field == "result": reply["result"] = {"private": OWNER}
            else: reply["control"]["outcome"] = {"private": OWNER}
            with self.assertRaises(ctl.Refused): ctl.validate_reply(reply, 1, (1, 2, 3))

    def test_forged_intent_hash_and_public_config_refuse_before_send(self):
        self.worker()
        with self.assertRaises(ctl.Refused):
            self.client().request("propose", intent=ctl.Intent(self.intent.body, "ef" * 32))
        (self.root / "fixture.json").chmod(0o644)
        with self.assertRaises(ctl.Refused): self.client().request("status")

    def test_symlink_control_endpoint_refuses_before_send(self):
        self.worker()
        endpoint = self.root / "control.sock"
        original = self.root / "original.sock"
        endpoint.rename(original)
        endpoint.symlink_to(original)
        with self.assertRaises(ctl.Refused): self.client().request("status")

    def observations(self):
        return [ctl.Observation(ctl.encoded({"action": "receipt", "operation_id": COMMAND["operationId"]}),
                                ctl.encoded(dict(copy.deepcopy(BASE), nodeId=node))) for node in (1, 2, 3)]

    def test_exact_three_voter_receipt_convergence_and_no_wabi_claim(self):
        receipt = ctl.convergence(self.observations(), self.intent)
        self.assertEqual(receipt["voters"], 3)
        self.assertFalse(receipt["automaticWabiRecoveryTested"])
        self.assertFalse(receipt["canonicalWriterPermitted"])

    def test_counts_cannot_replace_receipts_hashes_binding_and_applied_position(self):
        for mutation in ("hash", "position", "control", "permit", "node", "operation", "binding"):
            observations = self.observations()
            value = observations[2].value
            query = ctl.decode(observations[2].request)
            if mutation == "hash": value["operationsSha256"] = "ef" * 32
            elif mutation == "position": value["durableAppliedIndex"] = 6
            elif mutation == "control": value["control"]["committedAt"]["index"] = 6
            elif mutation == "permit": value["canonicalWriterPermitted"] = True
            elif mutation == "node": value["nodeId"] = 2
            elif mutation == "operation": query["operation_id"] = "2" * 32
            elif mutation == "binding": value["controlCommandSha256"] = "ef" * 32
            observations[2] = ctl.Observation(ctl.encoded(query), ctl.encoded(value))
            with self.subTest(mutation=mutation), self.assertRaises(ctl.Refused):
                ctl.convergence(observations, self.intent)

    def test_cli_synthetic_fixture_refuses_with_redacted_output(self):
        self.worker()
        result = subprocess.run([sys.executable, str(SCRIPT), "status", "--root", str(self.root),
                                 "--owner", OWNER, "--artifact-sha256", self.sha,
                                 "--config-sha256", self.config_sha, "--node-id", "1"],
                                capture_output=True, timeout=3,
                                env={"PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(json.loads(result.stdout)["result"], "REFUSED")
        for private in (OWNER, str(self.root), self.sha, self.config_sha, "Traceback"):
            self.assertNotIn(private, result.stdout.decode())

    def test_cli_argument_errors_are_redacted(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "status", "--unknown", OWNER],
                                capture_output=True, timeout=3,
                                env={"PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(json.loads(result.stdout)["result"], "REFUSED")
        self.assertNotIn(OWNER, result.stdout.decode())


if __name__ == "__main__":
    unittest.main()
