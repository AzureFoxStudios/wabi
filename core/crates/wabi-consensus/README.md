# Experimental recovery coordination

This crate is the durable coordination foundation for the geographic plan.
It is not enabled by `wabi-server` and grants no WabiDB writer permission.
`ControlReply.canonical_writer_permitted` is always false. Accepted ownership
intents do not open an engine, remove a recovery guard, transfer keys, or publish
application state.

## Scope

- Pinned OpenRaft 0.9.25 with its `storage-v2` contract.
- redb 2.6.3 transactions with immediate durability for votes, logs, committed
  position, applied control state and snapshot installation.
- A private existing node directory, persistent advisory lock and strict
  community/partition/node identity binding. The lock inode and its diagnostic
  contents are preserved. Replacement of the directory, lock or database
  refuses subsequent operations on Unix.
- A single owned blocking I/O lane. Cancellation of the waiting caller does not
  release the lane or database ownership before the actual write finishes.
- Deterministic compare-and-set ownership intents and durable operation receipts.
  Retrying an identical operation returns its original result. Reusing its ID
  with changed contents refuses. Intents only select structurally valid voters
  already present in the applied membership.
- Versioned JSON records, bounded snapshot receiving and atomic snapshot/state
  replacement. Source/community/partition, metadata, payload hash, receipt
  history and current applied position are checked before installing.

`trust::validate_three_voter_roster` checks the initial roster has exactly three
distinct site labels, node IDs, keys and IP endpoints, including the local node.
It does not authenticate those keys, prove physical sites, implement enrollment
or authorize membership changes. Helpers and volunteers are not roster inputs.

## Limits and storage

One node uses `consensus.redb`, with format
`wabi-control-v1/openraft-0.9.25-json`. There is no silent reset or format upgrade.
A private, stopped copy of this directory alone is not a complete Wabi backup.
No WabiDB file, projection, content blob, active key or checkpoint guard is opened.

Default limits are 100,000 log entries / 64 MiB encoded log bytes, 16 MiB snapshot
and applied-state bytes, 256 MiB database admission, and 64 MiB minimum free disk.
The redb cache is 16 MiB. Individual log records are limited to 1 MiB; a submitted
batch to 1,024 records / 8 MiB. The database admission check reserves headroom
before a transaction; it is not a filesystem quota against another process.
The deterministic state machine permits at most 4,096 partition intents and
16,384 operation receipts. It refuses additional transitions when full rather
than evicting idempotency history. This is a bounded foundation, not a capacity
claim for large communities or a finished retention/compaction policy.

## Acceptance command

Use the repository-pinned toolchain and shared target directory, with the shared
build slot free:

```sh
CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline --locked \
  -p wabi-consensus -- --test-threads=1
```

The tests use the actual transactional store and actual OpenRaft nodes. The
three-voter transport is an in-process test double. A subprocess fixture kills
the store process after its durable acknowledgment, without a graceful shutdown.
The ignored worker is invoked only by that parent test.

## Work required before activation

Authenticated encrypted RPC transport, enrolled/revoked membership, actual
process/uplink failures and delayed RPCs; quorum-committed canonical operations;
every-path publication and encryption-allocation fencing; complete checkpoint,
tail and blob recovery; stale writer reseed; client discovery/reconnect; room
ownership and permissions; capacity/privacy acceptance. Keep all promotion
guards in place until those contracts pass.
