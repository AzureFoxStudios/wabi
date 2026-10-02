#!/usr/bin/env python3
"""Exact three-host disposable ciphertext trial; never a production deployment.

Requires a completed real-producer export, frozen test ELF and explicit SSH
access to Ronin/Iyoku. No public-IP lookup, firewall rule or live-data operation.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import secrets
import selectors
import shlex
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
PURPOSE = "wabi-disposable-checkpoint-ciphertext-v1"
ROWS = [(1, "dotRonin", "100.80.172.12", None),
        (2, "Ronin", "100.87.255.66", "Ronin@100.87.255.66"),
        (3, "Iyoku", "100.104.166.42", "Iyoku@100.104.166.42")]
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3"]


def command(row, program):
    return [sys.executable, "-B", "-c", program] if row[3] is None else [*SSH, row[3], "python3 -B -c " + shlex.quote(program)]


def invoke(row, program, data=None, timeout=40):
    result = subprocess.run(command(row, program), input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(f"node{row[0]} command refused, exit {result.returncode}; stderr SHA {hashlib.sha256(result.stderr).hexdigest()}")
    if len(result.stdout) > 1024 * 1024 or len(result.stderr) > 1024 * 1024:
        raise RuntimeError("bounded field command output exceeded")
    return result.stdout


def fixed_json(row, program, data=None):
    return json.loads(invoke(row, program, data))


def host_command(row, state, action, worker=None, target=None):
    args = [state["tools"] + "/checkpoint-field-host.py", action, "--root", state["root"],
            "--owner", state["owner"], "--artifact-sha", state["artifactSha256"], "--node-id", str(row[0])]
    if worker:
        args.extend(["--action", worker])
    if target is not None:
        args.extend(["--target", str(target)])
    program = "import subprocess,sys;raise SystemExit(subprocess.call([sys.executable,'-B',*" + repr(args) + "]))"
    return command(row, program)


def host_run(row, state, action, worker=None, target=None, expected=True):
    result = subprocess.run(host_command(row, state, action, worker, target), stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=150)
    if len(result.stdout) > 1024 * 1024 or len(result.stderr) > 1024 * 1024:
        raise RuntimeError("bounded host output exceeded")
    value = json.loads(result.stdout)
    if (result.returncode == 0 and value.get("ok") is True) != expected:
        raise RuntimeError(f"node{row[0]} unexpected {action}/{worker} outcome: {value}")
    return {"nodeId": row[0], "actualExitCode": result.returncode, "expectedSuccess": expected, "reply": value}


def allocate(row, artifact_sha, owner):
    program = """
import os,json,socket,tempfile,pathlib
node,owner,sha,address = SETTINGS
with socket.socket() as probe:probe.bind((address,3000))
root=pathlib.Path(tempfile.mkdtemp(prefix='wabi-checkpoint-field-',dir='/tmp'));os.chmod(root,0o700)
tools=pathlib.Path(tempfile.mkdtemp(prefix='wabi-checkpoint-field-tools-',dir='/tmp'));os.chmod(tools,0o700)
print(json.dumps({'root':str(root),'rootIdentity':[root.stat().st_dev,root.stat().st_ino],'tools':str(tools),'toolsIdentity':[tools.stat().st_dev,tools.stat().st_ino],'artifactSha256':sha,'owner':owner,'host':socket.gethostname(),'freeBytes':os.statvfs('/tmp').f_bavail*os.statvfs('/tmp').f_frsize}))
""".replace("SETTINGS", repr((row[0], owner, artifact_sha, row[2])))
    return fixed_json(row, program)


def prepare(row, state, artifact, scripts):
    # Socket bind is only a fresh availability preflight, NOT authentication.
    program = """
import os,sys,json,socket,tempfile,pathlib,hashlib,gzip,subprocess
node,owner,sha,root_name,root_identity = SETTINGS
root=pathlib.Path(root_name)
assert [root.lstat().st_dev,root.lstat().st_ino]==root_identity and root.lstat().st_mode&0o077==0
assert not list(root.iterdir())
output=os.open(root/'probe.bin',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o700)
total=0;digest=hashlib.sha256()
with os.fdopen(output,'wb') as file,gzip.GzipFile(fileobj=sys.stdin.buffer) as source:
 while True:
  chunk=source.read(65536)
  if not chunk:break
  total+=len(chunk)
  assert total<=256*1024*1024
  file.write(chunk);digest.update(chunk)
 file.flush();os.fsync(file.fileno())
assert digest.hexdigest()==sha
fd=os.open(root/'bootstrap.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'w') as file:json.dump({'schemaVersion':1,'purpose':'wabi-disposable-checkpoint-ciphertext-v1','owner':owner,'nodeId':node},file)
env={'WABI_CHECKPOINT_FIXTURE_ROOT':str(root),'WABI_CHECKPOINT_FIXTURE_OWNER':owner}
run=subprocess.run([str(root/'probe.bin'),'--exact','checkpoint_identity_bootstrap','--ignored','--test-threads=1','--nocapture'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
assert run.returncode==0
markers=[]
for line in run.stdout.splitlines():
 before,separator,after=line.partition(b'WABI_CHECKPOINT_PUBLIC_V1 ')
 if separator:
  assert before in {b'',b'test checkpoint_identity_bootstrap ... '}
  markers.append(after)
assert len(markers)==1
print(json.dumps({'identity':json.loads(markers[0])}))
""".replace("SETTINGS", repr((row[0], state['owner'], state['artifactSha256'], state['root'], state['rootIdentity'])))
    state.update(fixed_json(row, program, gzip.compress(artifact, mtime=0)))
    payload = {"tools": state["tools"], "identity": state["toolsIdentity"], "scripts": scripts}
    program = """
import os,sys,json,pathlib,hashlib
payload=json.load(sys.stdin);root=pathlib.Path(payload['tools'])
assert [root.stat().st_dev,root.stat().st_ino]==payload['identity'] and root.stat().st_mode&0o077==0
assert not list(root.iterdir())
result={}
for name,body in payload['scripts'].items():
 assert name in {'checkpoint-field-host.py','rpc-probe-supervisor.py'}
 fd=os.open(root/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as file:file.write(body.encode());file.flush();os.fsync(file.fileno())
 result[name]=hashlib.sha256(body.encode()).hexdigest()
print(json.dumps(result))
"""
    state["toolHashes"] = fixed_json(row, program, json.dumps(payload).encode())
    return state


def cleanup_unclaimed(row, state):
    # Only fresh staging roots recorded before any transfer. No adoption of a
    # claimed guard, MaterialStore or unregistered persistent writer.
    payload = {"root": state["root"], "identity": state["rootIdentity"]}
    program = """
import os,sys,json,pathlib,stat
data=json.load(sys.stdin);root=pathlib.Path(data['root'])
assert root.parent==pathlib.Path('/tmp') and root.name.startswith('wabi-checkpoint-field-')
info=root.lstat();assert stat.S_ISDIR(info.st_mode) and [info.st_dev,info.st_ino]==data['identity']
assert info.st_uid==os.getuid() and info.st_mode&0o077==0
allowed={'probe.bin','bootstrap.json','recovery.key','fixture.json','manifest.json','ciphertext.age'}
entries=list(root.iterdir());assert all(p.name in allowed for p in entries)
for p in entries:
 m=p.lstat();assert stat.S_ISREG(m.st_mode) and m.st_nlink==1 and m.st_uid==os.getuid() and m.st_mode&0o077==0
for p in entries:p.unlink()
root.rmdir();print(json.dumps({'ownedRootRemoved':True,'unclaimedStageOnly':True}))
"""
    return fixed_json(row, program, json.dumps(payload).encode())


def configure(row, state, fixture, export):
    payload = {"root": state["root"], "rootIdentity": state["rootIdentity"], "fixture": fixture}
    if row[0] == 1:
        payload["manifest"] = (export / "manifest.json").read_text()
        payload["ciphertextHex"] = (export / "ciphertext.age").read_bytes().hex()
    program = """
import os,sys,json,pathlib
data=json.load(sys.stdin);root=pathlib.Path(data['root'])
assert [root.stat().st_dev,root.stat().st_ino]==data['rootIdentity'] and root.stat().st_mode&0o077==0
files={'fixture.json':json.dumps(data['fixture'],separators=(',',':')).encode()}
if 'manifest' in data:
 files['manifest.json']=data['manifest'].encode();files['ciphertext.age']=bytes.fromhex(data['ciphertextHex'])
for name,body in files.items():
 assert len(body)<=256*1024
 fd=os.open(root/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as file:file.write(body);file.flush();os.fsync(file.fileno())
print(json.dumps({'configured':True}))
"""
    fixed_json(row, program, json.dumps(payload).encode())


def cleanup_tools(row, state):
    payload = {"root": state["tools"], "identity": state["toolsIdentity"], "hashes": state.get("toolHashes", {}), "unclaimed": not state.get("claimed", False)}
    program = """
import os,sys,json,pathlib,hashlib,stat
data=json.load(sys.stdin);root=pathlib.Path(data['root'])
assert root.parent==pathlib.Path('/tmp') and root.name.startswith('wabi-checkpoint-field-tools-')
assert [root.lstat().st_dev,root.lstat().st_ino]==data['identity'] and stat.S_ISDIR(root.lstat().st_mode)
names=set(p.name for p in root.iterdir())
assert names <= {'checkpoint-field-host.py','rpc-probe-supervisor.py'}
assert data['unclaimed'] or names==set(data['hashes'])
for name in names:
 p=root/name;m=p.lstat();assert stat.S_ISREG(m.st_mode) and m.st_nlink==1 and m.st_uid==os.getuid() and m.st_mode&0o077==0
 if name in data['hashes']:assert hashlib.sha256(p.read_bytes()).hexdigest()==data['hashes'][name]
for name in names:(root/name).unlink()
root.rmdir();print(json.dumps({'ownedToolDirectoryRemoved':True}))
"""
    return fixed_json(row, program, json.dumps(payload).encode())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", required=True)
    parser.add_argument("--export-stage-record", required=True)
    parser.add_argument("--receipt", required=True)
    args = parser.parse_args()
    stage = json.loads(Path(args.export_stage_record).read_text())
    export = Path(stage["root"])
    manifest = json.loads((export / "manifest.json").read_bytes())
    claims = manifest["source"]["claims"]
    export_receipt = json.loads((export / "export.json").read_bytes())
    artifact = Path(args.artifact).read_bytes()
    artifact_sha = hashlib.sha256(artifact).hexdigest()
    scripts = {name: (HERE / name).read_text() for name in ("checkpoint-field-host.py", "rpc-probe-supervisor.py")}
    states, servers, steps = {}, {}, []
    receipt = {"schemaVersion": 1, "purpose": PURPOSE, "artifactSha256": artifact_sha,
               "export": export_receipt, "physicalAccepted": False, "steps": steps,
               "states": states, "cleanup": [], "canonicalWriterPermitted": False,
               "independentUplinksFreshlyVerified": False}
    path = Path(args.receipt)
    def save():
        temporary = path.with_suffix(path.suffix + ".next")
        temporary.write_text(json.dumps(receipt, indent=2) + "\n")
        os.replace(temporary, path)
    try:
        for row in ROWS:
            states[str(row[0])] = allocate(row, artifact_sha, secrets.token_hex(32))
            save()
            prepare(row, states[str(row[0])], artifact, scripts)
            save()
        peers = {str(row[0]): {"protocol": 1, "communityId": claims["communityId"],
                 "siteId": "physical-field-" + str(row[0]),
                 "publicKey": states[str(row[0])]["identity"]["publicKey"],
                 "rpcAddress": row[2] + ":3000"} for row in ROWS}
        for row in ROWS:
            state = states[str(row[0])]
            fixture = {"schemaVersion": 1, "purpose": PURPOSE, "owner": state["owner"],
                       "binding": {"communityId": claims["communityId"], "partitionId": "community/root", "nodeId": row[0]},
                       "peers": peers, "bindAddress": row[2] + ":3000", "sourceNode": claims["sourceNodeId"],
                       "manifestSha256": export_receipt["manifestSha256"], "lifetimeSeconds": 300}
            configure(row, state, fixture, export)
            steps.append(host_run(row, state, "claim"));state["claimed"] = True;save()
        steps.append(host_run(ROWS[0], states["1"], "run", "seed"));save()
        def start(row):
            process = subprocess.Popen(host_command(row, states[str(row[0])], "run", "serve"),
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            servers[row[0]] = process
            deadline = time.monotonic() + 15
            pending = bytearray()
            os.set_blocking(process.stdout.fileno(), False)
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while time.monotonic() < deadline:
                    for key, _ in selector.select(0.2):
                        part = os.read(key.fd, 4096)
                        if not part:
                            raise RuntimeError(f"node{row[0]} server exited before listener readiness")
                        pending.extend(part)
                        if len(pending) > 4096:
                            raise RuntimeError("listener readiness output limit")
                        if b"\n" in pending:
                            ready = json.loads(pending.split(b"\n", 1)[0])
                            if ready.get("listening") is not True or ready.get("nodeId") != row[0] or ready.get("manifestSha256") != export_receipt["manifestSha256"]:
                                raise RuntimeError(f"node{row[0]} listener refused: {ready}")
                            os.set_blocking(process.stdout.fileno(), True)
                            return
            raise RuntimeError(f"node{row[0]} listener readiness deadline")
        start(ROWS[1]);start(ROWS[2])
        for target in (2, 3):
            steps.append(host_run(ROWS[0], states["1"], "run", "push", target));save()
            steps.append(host_run(ROWS[0], states["1"], "run", "remote_receipt", target));save()
        steps.append(host_run(ROWS[1], states["2"], "stop"));save()
        stopped_server = servers.pop(2)
        output, error = stopped_server.communicate(timeout=10)
        receipt["stoppedNode2Server"] = {"actualExitCode": stopped_server.returncode, "intentionalOwnedProcessStop": True,
                                       "reply": json.loads(output), "outputSha256": hashlib.sha256(output).hexdigest()}
        steps.append(host_run(ROWS[1], states["2"], "run", "receipt"));save()
        steps.append(host_run(ROWS[1], states["2"], "lose_copy"));save()
        steps.append(host_run(ROWS[1], states["2"], "run", "receipt", expected=False));save()
        steps.append(host_run(ROWS[1], states["2"], "run", "pull", 3));save()
        steps.append(host_run(ROWS[1], states["2"], "run", "receipt"));save()
        start(ROWS[1])
        steps.append(host_run(ROWS[0], states["1"], "run", "remote_receipt", 2));save()
        receipt["transferAndReseedAccepted"] = True
    except BaseException as error:
        receipt["failure"] = str(error)
        save()
    finally:
        for row in ROWS:
            state = states.get(str(row[0]))
            if state is None:
                continue
            try:
                if row[0] in servers:
                    host_run(row, state, "stop")
                    output, error = servers.pop(row[0]).communicate(timeout=10)
                result = host_run(row, state, "cleanup") if state.get("claimed") else {"nodeId": row[0], "reply": cleanup_unclaimed(row, state)}
                result["tools"] = cleanup_tools(row, state)
                receipt["cleanup"].append(result)
            except BaseException as error:
                receipt["cleanup"].append({"nodeId": row[0], "error": str(error), "ownedScratchRemains": True})
            save()
        receipt["physicalAccepted"] = receipt.get("transferAndReseedAccepted", False) and len(receipt["cleanup"]) == 3 and all(
            item.get("reply", {}).get("ownedRootRemoved") is True for item in receipt["cleanup"])
        save()
    print(json.dumps({"physicalAccepted": receipt["physicalAccepted"], "steps": len(steps),
                      "cleanup": len(receipt["cleanup"]), "failure": receipt.get("failure")}))
    return 0 if receipt["physicalAccepted"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
