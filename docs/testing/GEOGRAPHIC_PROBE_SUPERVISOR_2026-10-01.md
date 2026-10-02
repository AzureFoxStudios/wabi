# Geographic probe lifetime and cleanup acceptance

**Subsequent physical result:** unchanged helpers now supervise the same frozen
Rust workers across dotRonin, Ronin and Iyoku. Each worker's failure/return and
a later minority/purged-metadata-snapshot trial passed with complete owned
worker/proxy/stage disposal. See [separate physical acceptance](PHYSICAL_ENCRYPTED_RECOVERY_RPC_2026-10-01.md).
The 33 synthetic checks below remain their dated acceptance. Physical worker
death does not prove whole-host or production Wabi recovery, and real remote
supervisor/controller death still needs its own scoped acceptance.

**Recorded:** 2026-10-01. **Result:** 33 local synthetic Linux process tests
passed. This accepts a probe-supervision prerequisite, not encrypted RPC,
physical three-site recovery or Wabi availability.

The security chat explicitly released only two new Python files while retaining
the shared compiled-source, manifests, lock and Cargo hold:

- `scripts/geographic-acceptance/rpc-probe-supervisor.py`
- `scripts/geographic-acceptance/rpc-probe-supervisor.test.py`

Its media scripts, production backend and shared target were untouched. The
pending Rust transport and earlier accepted durable-store source hashes still
match their respective receipts. No node key or remote fixture was created.

## Accepted operation

The supervisor claims an existing, explicitly disposable private root. Before
creating guard files, it checks the frozen private regular ELF artifact against
the caller's exact SHA-256. The real probe profile additionally checks private
configuration ownership/node binding and existing key-file metadata. It never
creates or reads the scalar key. The public CLI launches only the frozen ignored
recovery-worker test; synthetic tests use a copied local Python executable.

The launcher inherits the advisory supervisor lock until its actual child PID,
boot identity and process start position are durably registered. Registration
uses a private atomic file replacement and directory sync. The inherited lock
closes the gap in which an unregistered live child could otherwise be omitted
from crash cleanup. The artifact is executed through its held descriptor.

Controller input is a bounded local pipe carrying `keepalive` or `stop`, not a
network administration API. EOF, an idle controller, stop, supervisor signals
or the maximum lifetime stop the directly owned child; termination escalates to
kill if needed, followed by reaping. Keepalives cannot extend the absolute
lifetime. Linux `CLOCK_BOOTTIME` includes suspend, so laptop sleep cannot renew
the remaining allowance. Clock selection and an injected elapsed gap passed;
an actual hardware suspend test has not run.

Explicit `--allow-restart` adds a bounded `restart` controller frame. In this
mode an exited worker's fixture remains available only while the original
supervisor and controller lease live. A restart stops and reaps the directly
owned old child before registering a replacement with the same root, artifact,
configuration and arguments. The original supervisor lock stays held; existing
store files and the store lock inode remain intact. At most eight replacements
are allowed. Neither restart frames nor child loss renew the absolute lifetime
or idle lease; only keepalives renew the idle lease within the original lifetime.
Final stop, EOF, lease expiry or supervisor termination still disposes the root.
Refusal preserves an explicit pending-cleanup fixture. This mode does not resume
an application Authority or establish a successful Raft restart.

After supervisor death, cleanup must acquire the original supervisor lock and
validate root identity, owner, node and frozen artifact. A recorded live child
must match boot identity, start position and executable inode. Signals go
through a Linux pidfd, which pins the process independently of PID reuse.
Unrelated process identities are refused without signaling them. The local
orphan test used a temporary subreaper setting only on its own test process and
reaped the adopted child, then restored that setting.

Final disposal also acquires any existing consensus `.lock`; contention refuses
cleanup without changing its inode or diagnostic contents. Inventory ceilings
are checked before deletion. Descriptor-relative traversal does not follow
symlinks; named inode substitutions refuse. Lock names are removed only during
final disposal of a stopped owned fixture, never to admit a replacement writer.

## Verification matrix

| Assertion | Actual evidence |
|---|---|
| Normal exit, idle and absolute lifetime | Owned child exit/reap and exact root disposal; keepalives cannot reset lifetime |
| Same-store worker replacement | Actual worker SIGKILL plus a live-worker replacement retain exact synthetic durable-file and advisory-lock inodes; old children are reaped before replacement and final stop removes the root |
| Restart admission and lifetime | Explicit opt-in, eight-replacement limit, unchanged original supervisor lock, marker substitution refusal, idle/absolute expiry after child loss, restart frames cannot renew idle lease |
| Controller process dies | Actual SIGKILL of the sole controller pipe writer; supervisor observes EOF, stops/reaps worker and removes its root |
| Supervisor receives termination | Actual SIGTERM; owned worker drained and root removed |
| Supervisor dies abruptly | Actual SIGKILL, lock release, pidfd identity-checked adoption, forced worker stop and orphan reap |
| Unregistered launch window | Child inherits the original flock; closing the parent's descriptor does not permit cleanup until that child exits |
| Active store or supervisor | Real kernel flock contention refuses; diagnostic inode/contents remain unchanged |
| Substituted root, lock, artifact or ownership | Refusal preserves unrelated data; wrong executable/start identity never signals the unrelated process |
| Input and cleanup budgets | Invalid deadlines, malformed/oversized/deep/duplicate/linked records, bad control frames and excessive inventory refuse |
| Output and resource ownership | Fixed redacted CLI refusal, no traceback, no private paths/tokens in receipts; final run treats resource warnings as errors |

Command:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -W error::ResourceWarning \
  scripts/geographic-acceptance/rpc-probe-supervisor.test.py -v
```

The final process exited zero: **33 passed, zero skipped**, in approximately
9.2 seconds. Exact accepted source hashes, runtime, compressed logs and cleanup
are in [the receipt](geographic-2026-10-01/rpc-supervisor-contracts.json).
Earlier logs are superseded stages; the top-level source hashes cover the final
accepted run. No owned test roots or bytecode caches remained. Temporary logs
were removed only after their compressed copies were checked.
The earlier 25-test receipt is preserved separately; it predates restart mode.

The same four released supervisor/controller sources later passed **33 plus
25 checks on each of Ronin and Iyoku**, with terminal exit zero and no skips,
on their Python 3.14.7 runtimes. See the
[remote runtime receipt](geographic-2026-10-01/remote-python-helper-contracts.json).
These are synthetic private-stage tests, including actual process death,
restart, pidfd adoption and kernel Unix peer identity. Every stage/test root
was removed, with no owned live process group or bytecode cache left behind.
Verified compressed logs and bounded runner source remain; the exact local
temporary runner was removed. No node keys, TCP listeners or Wabi service were
created. Rust/Noise/Raft and interhost recovery were not exercised.

## Scope and remaining work

This is a trusted-operator fixture tool on Linux with local private staging,
compatible `/proc`, pidfd and advisory-lock behavior. It does not sandbox the
worker. Do not introduce mounts or independent writers into its owned root.
Synchronous filesystem/process syscalls can still stall; the deadline is not a
kernel or storage failure guarantee. Failed cleanup stays an explicit refusal
and must be resolved before another physical run.

The later [Rust executable acceptance](ENCRYPTED_RECOVERY_RPC_2026-10-01.md)
passes 39 checks; a separate actual Rust/Python run verifies guarded follower
restart, unchanged key/store-lock inodes and complete cleanup of three local
workers. These are distinct from the synthetic prerequisite receipt above.
Use the matching frozen executable and supervisor, provision separate node keys,
verify each physical host and repeat process/controller loss and cleanup across
the three sites. See [encrypted recovery acceptance](ENCRYPTED_RECOVERY_RPC_PLAN.md).

No WabiDB/application state, member data, upload, identity key or Authority was
opened by these tests. Complete recovery state, safe canonical writer/nonce
ordering, surviving discovery, regional room ownership and capacity/privacy
remain mandatory. `canonical_writer_permitted` remains false; no Wabi failover
gate is closed by this result.
