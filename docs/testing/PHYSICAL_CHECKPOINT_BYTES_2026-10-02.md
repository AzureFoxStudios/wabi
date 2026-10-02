# Physical encrypted checkpoint transfer — October 2

## Current result

**Partial physical acceptance; the complete restart sequence remains open.**
This is main Wabi, before ERP. No Authority promotion, automatic failover,
regional room ownership, byte quorum or large-community capacity is established.

The existing local byte-RPC implementation passed its earlier frozen workspace
run: 2,673 passed, zero failed, 15 ignored entries. That result is a distinct
source receipt. This phase adds test fixtures and process orchestration, with no
production transport, writer, dependency or persistent-format changes.

## Real producer and local fixtures

- Consensus session 54424: actual exit 0, **75 passed, zero failed, seven
  ignored entries across six groups**. All 31 recorded consensus/manifest/lock
  inputs matched before-launch hashes. The first restricted run refused TCP
  binds with EPERM and is retained as failed evidence, not accepted networking.
- Producer session 42830: actual exit 0, **seven passed, zero failed, one
  ignored exporter**. All 5,174 recorded current workspace/embedded inputs
  matched. The newer UI embedding is recorded separately; this is not a fresh
  full-workspace acceptance of that UI.
- Explicit exporter session 15293: actual exit 0, **one passed, zero failed**.
  It used a real disposable Authority capture and registered 160 KiB upload,
  independently decrypted the archive locally, and reconstructed the Authority
  before reporting export completion. The field payload is **174,102 encrypted
  bytes in three ordered chunks**, plus its signed manifest. The age decryption
  identity remained in the local producer's temporary directory and was not
  exported to either remote computer.
- Private process/file/lock guards: **11 checks passed** after the fixture
  output parser corrections. Tests explicitly reject fake success from a
  synthetic `/bin/true` child. The later listener-readiness path has not yet
  completed physical acceptance.

The new Rust executable is 8,511,720 bytes. Exact source, executable and script
hashes are recorded in `geographic-2026-10-02/checkpoint-physical-before*.json`.
The old metadata worker/control schema and its helpers remain unchanged.

## Three-computer trial

The fixed enrolled Noise roster used:

| Computer | SSH account / destination | Role in this disposable trial |
|---|---|---|
| dotRonin | local / 100.80.172.12 | Actual producer ciphertext source and transfer client |
| Ronin (bazzite) | Ronin@100.87.255.66 | Recovery copy 2 |
| Iyoku (192.168.1.11) | Iyoku@100.104.166.42 | Recovery copy 3 and reseed source |

Existing private port 3000 was checked for availability before staging. The
trial created temporary authenticated listeners; it did not alter firewall
rules, install a service, deploy production Wabi or read live community data.
Current independent internet uplinks were **not** freshly verified. No public
IP address query was repeated.

Attempt 3 completed 14 recorded steps:

1. Both remote computers bootstrapped their own private identities and claimed
   the exact frozen test artifact and public roster.
2. dotRonin ingested the genuine encrypted capture, sent all required chunks to
   both remote copies, and obtained authenticated target-bound fresh receipts.
3. The owned Ronin copy process was stopped and its supervisor reaped it.
   Reopening that same private store still verified the complete checkpoint.
4. Only Ronin's exact ciphertext blobs and manifest were deleted under the
   owned store lock. Its key, binding and lock inode were preserved. A subsequent
   local receipt correctly refused the missing copy.
5. Ronin retrieved the manifest and bytes directly from Iyoku over Noise,
   certified the restored copy locally, and passed another local fresh receipt.
6. The final request to Ronin's restarted listener failed. Its cause was not
   established by that attempt; the earlier fixed half-second startup delay was
   insufficient evidence of listener readiness. The complete run remains failed.

Every receipt retained allocation `unknown` and false source-role, encryption,
inactive-replay, quorum, full-instance and writer-permission flags. Independent
decryption in the producer fixture does not turn a remote opaque-copy receipt
into an activation permit.

## Failures, cleanup and next check

- Attempt 1 refused a Rust test-runner output prefix during local bootstrap;
  it reached no remote host and removed its own staging.
- Attempt 2 refused a `bytearray` parser result after local ingestion. All
  three staged roots and tool directories were removed; no complete physical
  transfer acceptance was claimed.
- Attempt 3 proved the transfers and peer reseed listed above, but failed the
  final restart request. All three roots and tool directories were removed.
  Their structured cleanup responses are preserved with the failed run.
- Attempt 4 **has not executed**: automatic approval review timed out before
  launch, including its one allowed retry. This is not a finding that the test
  is unsafe. Guidance was requested; no further network retry was attempted.

The next harness version forwards an exact, bounded listener-ready record
after the actual Rust bind, then performs the authenticated receipt request.
It also records failed worker exit/error codes without publishing keys or raw
payloads. This version needs its physical run; the three earlier failures remain
available rather than being overwritten.

The completed producer's private encrypted export is retained temporarily for
that exact retry: under 200 KiB, no decryption identity, no new Cargo target
tree. Completed raw logs are removed only after exact gzip comparison. Shared
build caches, other chats' files and all live lock inodes remain untouched.

## Evidence

See `geographic-2026-10-02/checkpoint-field{1,2,3}.json`,
`checkpoint-producer-field1.json`, `checkpoint-export1.json`,
`checkpoint-host{1,2,3,4}.json`, `checkpoint-physical{1,2,3}.json`, their
before-launch source receipts and gzip logs. Earlier local byte acceptance is
in [the byte-RPC report](AUTHENTICATED_CHECKPOINT_BYTES_2026-10-02.md).

Committed byte availability, independent inactive verification, safe encryption
allocation and old-writer fencing, client recovery, automatic full-Wabi
failover, regional selective delivery and capacity/privacy gates remain in
[the master plan](../plans/2026-09-26-geographic-community-nodes.md).
