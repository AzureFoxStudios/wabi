# Durable recovery coordination acceptance — October 1

## Executed scope

The shared worktree on **dotRonin**, `/home/ironin/wabi`, branch
`codex/security-boundary-hardening-20260930`, base `138abe39`, adds the isolated
`wabi-consensus` crate. The final pinned offline/locked run exited **0**:

```sh
CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline --locked \
  -p wabi-consensus -- --test-threads=1
```

**16 tests passed:** one cancellation unit, twelve storage contracts and three
actual OpenRaft voter scenarios. One storage test runs the unmodified upstream
OpenRaft suite's **35 subcontracts** against the actual disk-backed store. The
ignored subprocess worker is invoked twice by its passing parent kill test;
it is not an unexecuted acceptance case. Doc tests contain zero cases.

The [machine-readable receipt](geographic-2026-10-01/durable-consensus-contracts.json)
records exact source, manifest, lock, executable and log digests, compiler,
counts, dependency changes and scope flags. Compressed logs include failed
attempts and the passing final run. Earlier successes from other binaries are
not substituted for these results.

## Storage contracts

- Private existing directory and exact community/partition/node/schema binding;
  exclusive persistent advisory lock, preserved inode and diagnostic contents.
  Unix directory/database/lock substitutions refuse subsequent operations.
- Immediate transactional durability for votes, consecutive logs, committed
  position, applied control state, operation receipts and snapshot installation.
  Vote/commit regressions, changed committed entries and middle gaps refuse
  atomically. A superseded compacted prefix remains absent when storage recovery
  resubmits it; a future term claiming a purged position refuses.
- A caller cancelled during an unfinished transaction cannot release the owned
  I/O lane or admit another store. A following read waits for the actual commit,
  and the acknowledged vote survives reopen.
- Separate child processes are killed after acknowledgment at two boundaries:
  durable vote/log/committed position before application; and durable applied
  receipt plus snapshot. Reopen verifies exactly the corresponding state. The
  parent kills and reaps its owned children even on failure.
- Identical operation retries return the original durable result after restart;
  changed content under the same ID refuses; stale expected epochs conflict.
- Snapshot receive/write/seek limits, encoded log/state limits and pre-serialization
  field bounds; refused operations leave log and applied positions unchanged.
- Wrong community, changed metadata, stale snapshot, missing receipt, inconsistent
  epoch/inventory and forged writer-permission flag refuse before installation.
  The consistency cases recompute a matching payload hash, so hash agreement
  alone cannot admit malformed state.
- Initial roster preflight requires exactly three distinct node/site/key/IP
  endpoint bindings and a compatible protocol/community. This checks structure;
  encrypted transport and authenticated enrollment are subsequent work.

Initial runs exposed and corrected a missing redb trait import, non-private
test fixtures, an unchecked `false` lock-contention result and disagreements
with the upstream log-store recovery contract. Final acceptance retains the
strict lock rule and the full upstream suite.

## Three-voter scenarios

The tests run actual OpenRaft nodes, actual private transactional stores and an
**in-process controlled transport**:

1. Stop and return each node while the remaining majority commits ownership
   intents; restart all three stores/nodes; retry the original operation without
   advancing its outcome twice.
2. Cut an old leader off from the other two voters. The isolated node cannot
   acknowledge a new quorum write. The majority elects and commits the next
   intent. After healing, all applied states converge and the minority's
   uncommitted operation is absent.
3. Stop a follower, commit thirty subsequent transitions and wait for actual log
   purge. Its return must install a durable snapshot to catch up. It retains all
   thirty-one operation receipts across another restart.

The voter stop scenarios use explicit Raft shutdown. The separate storage kill
contract uses process termination. These are separate kinds of evidence.

## Boundaries and resources

Every control outcome sets `canonical_writer_permitted = false`. `wabi-server`
does not link or activate this crate. No WabiDB state/key/guard or live deployment
was opened or changed. The tests establish local coordination/storage behavior.
Physical authenticated RPC, enrolled/revoked voting membership, delayed messages,
complete instance recovery, every-path writer/publication/nonce fencing, client
reconnect, per-room regional ownership and capacity/privacy gates remain open.
Package 4 of the master plan remains open; packages 5–12 retain their gates.

The crate's [documented limits](../../core/crates/wabi-consensus/README.md) include
a 16 MiB redb cache, bounded logs/state/snapshots and a finite deterministic receipt
ledger. No large-community capacity claim follows from these small tests.

The shared build slot was released by the security chat before our first build
and returned after the final run. One build job, the existing target directory
and the pinned toolchain were used throughout. The final receipt confirms the
security-patched h2/rustls/crossbeam versions remain present. The pre-fetch lock
copy was never restored over another chat's changes.

Passing scenarios explicitly shut down their Raft nodes and child processes;
their private fixture directories are owned by `TempDir`. Temporary attempt logs
are compressed into evidence before removal. Shared build artifacts are retained
for subsequent integration checks. Approximately **82 GiB** remained available
when saving the receipt. No new remote staging area, listener or production
service was created in this continuation.
