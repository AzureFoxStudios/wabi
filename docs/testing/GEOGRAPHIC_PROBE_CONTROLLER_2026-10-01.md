# Disposable recovery probe controller acceptance

**Subsequent physical result:** the same controller later validated actual
frozen Rust replies across dotRonin, Ronin and Iyoku, including every worker's
return, minority no-ACK/heal and purged metadata snapshot/second restart. See
[the separate physical acceptance](PHYSICAL_ENCRYPTED_RECOVERY_RPC_2026-10-01.md).
The 25-check slice below remains its original synthetic acceptance; physical
results do not make it a Wabi recovery controller or grant writer permission.

**Recorded:** 2026-10-01. **Result:** 25 local synthetic Linux checks passed.
This slice verifies controller prerequisites only and predates Rust compilation.
It did not test Noise, Raft or physical Wabi recovery. The later
[Rust executable acceptance](ENCRYPTED_RECOVERY_RPC_2026-10-01.md) and
[real control-interface receipt](geographic-2026-10-01/rust-python-control-codec-contract.json)
record the subsequent local executable results separately.

The security owner explicitly released the two new controller Python files,
private synthetic children/Unix sockets and owned roots. It also released the
existing nested `tests/pending/encrypted_tcp_contract.rs` for a receipt
correction and parser check. Compiled source, module wiring, manifests, lock,
shared target and Cargo remain held by that chat.

## Controller admission and bounds

The caller supplies the existing private fixture root, owner, node ID and exact
executable/configuration SHA-256 values. Before connecting, the controller
checks private held root/marker/artifact/configuration, the actively held
original supervisor lock inode, worker boot/start/executable identity and a
private Unix socket. Kernel peer PID/UID must match that worker; root, socket,
marker and executable identities are checked again after connection.

Only status, original-operation receipt, initialization, bounded ownership
proposal and worker stop are supported. Length-prefixed JSON frames are at
most 4 KiB; duplicate fields refuse. A client permits at most 128 attempted
requests, each with a maximum five-second deadline. Reply fields/types, node
IDs, log positions and limits are checked. Canonical writer permission refuses.
The optional lease uses an already owned nonblocking pipe, bounded keepalives
and at most eight restart frames. It creates no waiter queue or lifetime
renewal; a full pipe refuses immediately.

## Exact original proposal proof

Epoch, outcome and log position cannot identify which proposal was stored.
Immutable `Intent` bytes preserve operation ID, partition, expected epoch,
proposed writer and checkpoint digest. Their declared field order matches the
pinned Rust `ControlCommand`. The controller requires `controlCommandSha256`
from the persisted command, never an echoed retry payload.

A lost proposal response is indeterminate and never causes automatic resend.
Lookup must match the original fingerprint. Missing proof refuses; changed
contents under the same ID cannot borrow an earlier receipt. Three-voter
convergence additionally requires distinct expected nodes, exact original
queries, matching accepted receipts, applied positions covering the receipt,
and matching full operation-state hashes/counts/epochs. Counts alone refuse.

The **pending Rust fixture source** now hashes
`ControlState.operations[id].command`, with a cross-language golden assertion,
changed-content refusal/readback, and fingerprint readback after restart and
snapshot/restart. These Rust assertions subsequently passed in the 39-check
executable run. The later actual Rust/Python interface run also passed strict
reply decoding, exact three-voter receipts and guarded follower restart.
Neither result substitutes for physical three-site or Wabi recovery acceptance.

## Executed evidence

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -W error::ResourceWarning \
  scripts/geographic-acceptance/rpc-probe-controller.test.py -v
```

Final exit zero: **25 passed, zero skipped**, about 4.2 seconds. Private Unix
mock workers exercised fragmented replies, lost proposal/bound lookup,
changed-content/missing-proof refusal, wrong logical node, oversized/duplicate
responses, deadline expiry, kernel peer mismatch, changed/public configuration,
socket symlink, inactive supervisor and CLI redaction. Lease tests cover stalled
replies, full nonblocking pipes and restart limits. Pure evidence checks cover
convergence and contradictory receipts, contents and positions.

The initial sandboxed attempt could not create Unix sockets (`EPERM`) and is
preserved as failed prerequisite evidence. The approved local run outside that
restriction passed 21 checks; the expanded final run passed 25. Final source
hashes cover the final run only. Superseded logs, exact provenance and cleanup
are in [the receipt](geographic-2026-10-01/rpc-controller-contracts.json).

Owned children were stopped/reaped; owned roots and bytecode caches were checked
absent. Logs were removed only after compressed copies matched. No scalar node
key, member content, WabiDB, Authority, remote fixture, TCP listener or shared
build was touched. This is trusted-operator Linux fixture control, not a worker
sandbox or an operating-system failure guarantee.

A subsequent [read-only physical platform preflight](geographic-2026-10-01/physical-controller-platform-preflight.json)
passed on the expected Ronin and Iyoku hosts, both x86_64 with Python 3.14.7.
Opening and closing a self pidfd and private Unix socket pair actually
succeeded. Signal, peer-credential and suspend-clock APIs and required `/proc`
paths were present; at that preflight their complete behavior and these helper
suites had not run remotely. No persistent remote file, fixture worker, key, TCP listener or
additional public address check was created. Local helper tests used Python
3.12.3; platform presence does not certify runtime or codec compatibility on
Python 3.14.7.

The subsequent [remote runtime receipt](geographic-2026-10-01/remote-python-helper-contracts.json)
records all **33 supervisor and 25 controller checks passing separately on
both Ronin and Iyoku**, with terminal SSH/test exits zero and no skips, using
the same four source hashes on Python 3.14.7. This actually exercises the
synthetic kernel peer-credential, process-death, restart and owned-cleanup
contracts on those hosts. It does not run Rust or send Noise/Raft traffic
between the computers. Each private remote stage and its test roots was removed;
no owned live process group or bytecode cache remained. Four compressed logs
and the bounded orchestration source were verified before the exact temporary
local runner was removed. No node key, TCP listener or Wabi service was created.

Next: use the locally verified frozen artifacts and this controller with the
[supervisor](GEOGRAPHIC_PROBE_SUPERVISOR_2026-10-01.md) on actual sites. Whole
instance recovery, fencing, discovery, room ownership and capacity/privacy
remain required; no Wabi recovery gate closes here.
