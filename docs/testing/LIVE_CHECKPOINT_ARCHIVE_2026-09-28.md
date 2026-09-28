# Encrypted live core checkpoint checks — 2026-09-28

**Scope:** Disposable local main Wabi; working-tree component, not deployed.  
**Result:** All 45 selected checks passed. No complete-instance or failover gate has passed.

## Contract under check

The internal exporter consumes the coordinated application/database/projection
boundary and streams whole core roots directly into age ciphertext. It records
the running signing/bootstrap keys, resolved server configuration, applied
position and commit prefix. The V2 restorer verifies file/inventory digests and
key/prefix continuity, then installs an inactive live marker and writer fence
before publishing a new private directory. See [the archive contract](../deployment/LIVE_CHECKPOINT_ARCHIVE.md).

## Main Wabi integration fixtures

`live_checkpoint_archive_contract` defines four cases:

1. A real AppState creates ownership, a consumed recovery code, a session
   denial, retained/deleted messages and published/revoked uploads. Unknown
   files, empty directories and Tailcat key state are included. The fixture
   deliberately replaces its persisted key files with stale values **after**
   engine initialization, then verifies export uses the actual in-memory keys
   without changing those source files. This does not claim that the source
   could restart with those deliberately damaged persisted files. An inactive
   engine reopen checks canonical security state and retained history. Full
   Authority startup and passive local commands must refuse. A later source
   write does not change the frozen copy.
2. Entry, byte, path and elapsed-copy budgets refuse export, leave no published
   archive and release the source for later work. A subsequent accepted export
   checks embedded uploads are captured once. These are early resource-limit
   refusals; partial-file/panic cleanup has separate low-level tests.
3. An external blacklist and enabled Lore each refuse an incomplete export.
4. A real separate inbox process receives, stores and returns the live
   ciphertext on an ephemeral loopback listener. The archive's SHA-256 must
   match the trusted source receipt after send, repeated-ID refusal, rejected
   credentials and fetch. CLI restore **without** a passive flag must still
   install both fences. Passive inspection retains the checkpoint's history,
   excludes a later source write and keeps `fullInstanceReady: false`.

All four cases passed the final run. An earlier development run first needed
uploads directories created in two fixture setups. The fixtures refuse an
external `WABIDB_ROOT_KEY` override so isolated test engines cannot accidentally
use an operator's configured database key.

## Archive framing and compatibility tests

Fifteen new low-level tests cover authenticated-but-invalid file digests,
inventory footers, trailing bytes, unsafe/duplicate paths, entry types,
oversized headers, unsupported readiness claims and mismatched position/prefix/
keys. Other cases cover wrong identities, damaged/truncated ciphertext,
source rehashing despite unchanged size/mtime, inventory/copy limits, symlinks,
non-UTF-8 names and preserving existing output files.

The output-ownership tests inject panic before and after publication and check
that unaccepted files disappear, accepted output survives and files not created
by this attempt are preserved. Inactive-restore checks omit the passive flag,
reject stopped activation and retain the live guard after removing only the
ordinary writer fence in the isolated fixture.

These tests use a **synthetic empty storage tree** for archive framing and key
checks. They do not prove a usable WabiDB installation. A missing storage
manifest in that synthetic fixture caused two initial failures; it was added
before the final rerun. The real engine/read acceptance is in the AppState
integration cases. Thirteen existing stopped snapshot/move tests remain in the
same target to check V1 compatibility.

The final snapshot target passed all **28** cases (15 new low-level checks and
13 existing stopped snapshot/move checks), with no failures or ignored tests.

## Engine and boundary regression scope

The engine checkpoint suite includes a live marker alone refusing local commits
without an ordinary durable writer-fence file. The existing coordinated
checkpoint integration target checks source drain, copy cancellation/failure,
interruption veto and guard ownership. This does not test distributed leases,
unavailable-host promotion or regional room independence.

## Results and provenance

| Selected target | Passed | Failed / ignored |
|---|---:|---:|
| Snapshot/archive units (15 new, 13 V1 regressions) | 28 | 0 / 0 |
| Live main Wabi archive/inbox/CLI restore | 4 | 0 / 0 |
| Existing coordinated checkpoint contracts | 6 | 0 / 0 |
| Engine checkpoint and live-marker fence | 7 | 0 / 0 |
| **Total test executions** | **45** | **0 / 0** |

Commands, source/log hashes and cleanup are recorded in the
[machine-readable receipt](live-checkpoint-archive-2026-09-28/receipt.json).
The repository-pinned Rust 1.93 toolchain, locked dependencies and disabled
incremental output were used. Existing compiler warnings remain. The initial
engine check was terminated with exit 143 while still waiting for the artifact
lock; it had run no tests. Its retry passed all seven selected cases. The
counts above include only the final successful run of each target.

The source now also disables incremental compilation by default for workspace
development/test profiles. A cached `--no-run` validation completed after that
manifest change; the tested commands' explicit `CARGO_INCREMENTAL=0` already
used the same setting. An operator can opt into incremental builds when disk
allows it. This changes build caching, not runtime behavior.

## Cleanup

After the test processes completed and no compiler was running, cleanup held
the Cargo artifact lock and removed the completed generated incremental cache,
three owned test executables and their dependency files, and the captured logs.
Approximately **13.1 GiB of actual filesystem free space** was recovered. The
logical file-size sum was about 14.2 GiB; shared/hard-linked files make that
different from physically freed space. Source, data, runnable programs and
shared dependencies were retained. The final engine retry log is captured and
removed separately; its shared library test executable is retained.

## Limits

- This is local fixture verification; no current hosted data, remote deployment,
  firewall changes or physical multi-network recovery is involved.
- Archive integrity is not producer authentication. The inbox case binds the
  fetched ciphertext to a source-generated digest through an authenticated
  transport; independent membership/enrollment remains separate work.
- General operator/plugin/external-state coverage, comprehensive historical
  replay/retention validation and an operator trigger remain open.
- Restores remain inactive. No promotion, RPO/RTO, automatic failover, sustained
  capacity or privacy acceptance is established.
- Fixture directories and child processes are owned temporary resources. The
  selected tests do not create an operator-facing checkpoint endpoint or claim
  a deployment/promotion took place.
