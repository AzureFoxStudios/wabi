# Local recovery material acceptance

**Recorded:** 2026-10-01. Main Wabi, before ERP. Working-tree candidate only.

The isolated `wabi-consensus::material` module stores bounded **opaque bytes**
and issues receipts for the exact required objects and manifest on one node.
It has no Authority, Raft material-transfer or activation wiring. Callers must
supply already protected material; this module does not certify encryption,
source authenticity, tail semantics, inactive replay or complete-instance state.

## Actual results

The pinned, one-job, offline/locked package command was run twice, without a
source change between runs:

| Run | Actual exit | Passed | Failed | Ignored child entrypoints |
|---|---:|---:|---:|---:|
| Session 41476 | 101 | 49 | 1 | 4 |
| Session 99714 | 0 | 50 | 0 | 4 |

All 11 new material parent tests passed in both runs. The first failure was the
unchanged three-voter fixture's leader selection followed by
`ForwardToLeader(Some(3))`, at `three_voter_contract.rs:257`. The same-source
rerun passed; it does not establish that the timing race is repaired. Both logs
are retained. The four ignored child entrypoints are explicitly invoked by
parent contracts; they are not omitted acceptance scenarios.

The new tests cover:

- exact checkpoint-chunk concatenation, tail/blob object hashes, canonical
  manifest identity, sequence bounds and community/partition context;
- missing, changed, corrupted, reordered and substituted bytes refusing fresh
  receipts; existing objects cannot be replaced by a retry;
- object size, aggregate size/count, manifest count and free-space budgets;
- concurrent duplicates, binding mismatch and ownership retained by clones;
- unrelated/public/symlinked roots, redirected directory/lock identity and
  symlinked/hardlinked/public required files refusing use;
- eight actual owned-child SIGKILL cases: object and manifest publication after
  stage fsync, final hard-link, stage unlink and directory fsync. Reopen cleans
  only recognized owned stages, preserves the original lock inode, and never
  invents a receipt for an unpublished manifest.

Publication is create-only, with file fsync, hard-link without replacement,
stage unlink and directory fsync. Receipt lookup rechecks required hashes and
syncs files/directory before responding. A crash can leave an indeterminate
published outcome; fresh verification derives its receipt. Tests exercise
process death, **not whole-host power loss** or storage-device flush guarantees.

## Scope and provenance

The Linux implementation pins a private directory descriptor and verifies its
named identity, file owner/mode/link count and persistent advisory-lock inode.
It does not isolate mutually hostile processes running under the same OS user.
Synchronous I/O requires a future owned blocking lane/deadline contract before
network serving. Default limits are 1 MiB per object, 64 MiB stored objects,
1,024 objects, 128 manifests and 64 MiB reserved free space. There is no garbage
collection, reseeding or recovery-byte transport implementation yet.

Receipts are immutable through the public Rust API, serialization-only, and
explicitly scoped `local_required_bytes_only`. Source authenticity, payload
encryption, inactive replay, quorum availability, full-instance readiness and
canonical writer permission remain **false**. An inventory/key-context hash is
a binding value, not proof of its underlying meaning. Synthetic test bytes are
not Wabi recovery archives.

[Exact source digests, both actual results and compressed source/log evidence](geographic-2026-10-01/material-contracts.json)
cover 21 files. Seventeen existing sources are unchanged; only the released
`lib.rs` wiring and three new material sources were edited. Root/package
manifests and the current lock were unchanged by this step. The shared security
chat received the frozen receipt before its next full workspace run.

Cargo relinked the TCP test executable at its existing path. Its new SHA is
recorded separately. The earlier physical tests remain bound to their historical
`524550…dd3ec` executable and source receipt; they were not rerun with this build.
No shared target tree, live service, firewall, public address or remote test
installation was changed. The two owned temporary logs were removed after
compressed-byte verification; about 46 GiB remained free.

## Remaining integration

Next connect supported real encrypted exports and inactive verification to this
manifest, authenticate and durably transfer required bytes to the selected
majority, and bind availability to the committed control outcome. Complete
enabled-instance inventory, retention/reseed, canonical operation identity,
writer/publication/nonce fencing, client discovery, automatic Wabi recovery,
regional room ownership and capacity/privacy gates remain mandatory. This
local module closes none of Gates B, C or D by itself.
