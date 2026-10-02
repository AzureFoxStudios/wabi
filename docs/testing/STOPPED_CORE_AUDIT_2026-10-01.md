# Bounded stopped-core audit and clean restore — 2026-10-01

**Result:** 14 small audit tests and one real stopped V1 core restore rehearsal
PASS. Candidate only; whole enabled-instance readiness and automatic recovery
remain open.

## Private whole-tree comparison

`scripts/geographic-acceptance/stopped-tree-audit.py` compares explicit data and
uploads roots on one Unix computer. It holds both persistent WabiDB advisory
locks for the comparison, preserving their inode and diagnostic contents.
Missing lock files are created privately and kept. A live advisory writer,
legacy root PID lock, unsafe lock or overlapping/aliased roots refuses the
audit. Old PID-lock binaries and independent plugin/sidecar writers must be
stopped separately; this is not a live snapshot boundary or remote attestation.

```sh
python3 scripts/geographic-acceptance/stopped-tree-audit.py \
  --left-data /private/source/data --left-uploads /private/source/uploads \
  --right-data /private/restored/data --right-uploads /private/restored/uploads
```

Every unknown regular file and empty directory participates. Embedded uploads
are visited once in the uploads namespace; a separate uploads root is also
supported. Symlinks, hard links and unsupported entries are refused. Reads use
directory descriptors and no-follow opens, stream file hashes, check inode and
metadata stability, and refuse detected concurrent changes. Trusted private,
stopped roots remain a precondition: these checks do not fence an administrator
or an independent writer that ignores the WabiDB lock.

Only four exact data-relative runtime paths are omitted:
`wabidb/.lock`, `.wabi-secret-publication.lock`,
`wabidb/.wabi-secret-publication.lock`, `tailcat/addr.txt`.
Other files named `.lock` participate. The legacy root `data/.lock` is refused
for manual stopped-version review. No lock is unlinked by this tool.

`--inactive-live` additionally requires both restored V2 guards with their
expected contents, omits those two destination guards from comparison, and
leaves them in place. It never removes a fence or starts that copy. For an
externally overridden live key, the protected checkpoint's substituted **active
key material** must be the reference; stale source files correctly mismatch.
This mode checks marker presence/content only, not the archive header's commit
fingerprint or a promotion protocol.

The projection JSON parser validates the exact watermark/index/hex-entry shape,
unique index names and unique decoded keys, then reports an order-normalized
digest/count/watermark. That diagnostic does not relax whole-file byte equality:
even a reordered raw snapshot causes comparison FAIL. Persisted root-key format
and a nonempty JWT file are required; agreement does not certify runtime secret
overrides or external configuration.

| Shared budget across both trees | Default | Maximum |
|---|---:|---:|
| Entries | 25,000 | 100,000 |
| File bytes read | 4 GiB | 16 GiB |
| Relative path bytes | 1 MiB | 16 MiB |
| Cooperative deadline | 120 seconds | 300 seconds |

Additional fixed limits: depth 64, projection JSON 4 MiB and 50,000 projection
entries. The deadline is checked between filesystem operations, not a kernel
I/O cancellation guarantee. Results contain counts, fixed refusal codes and a
whole-projection digest; no filenames, individual key hashes, contents,
credentials or endpoint addresses are printed. PASS means the declared stopped
core filesystem comparison passed. `fullInstanceReady`, external-state and
Authority-recovery flags remain false.

## Executed regression and real-process evidence

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/geographic-acceptance/stopped-tree-audit.test.py -v
node scripts/geographic-acceptance/stopped-core-rehearsal.mjs \
  /absolute/path/to/wabi-server /absolute/path/to/wabi-instance-snapshot
```

The [small-test receipt](geographic-2026-10-01/stopped-audit-tests.json) records
14 passing cases: unknown files/empty directories, exact runtime exclusions,
preserved lock inode, active writer refusal, process-kill lock release, required
inactive guards, symlink/FIFO/hardlink refusal, root safety, embedded/separate
uploads, budgets/deadline, strict projection schema/hex/duplicates, key material,
changed-file detection and private CLI failures. One initial mutation-test
fixture changed an unread file rather than the open file; it was corrected.

The [real rehearsal](geographic-2026-10-01/stopped-core-rehearsal.json) uses
existing local binaries; no Rust compilation or binary copy was needed. It
creates two fixture accounts, a retained room/message, a completed attachment
and a revoked session, cleanly stops the source, adds unknown stopped state,
exports an encrypted V1 archive, binds restore to the source ciphertext hash,
and compares all 59 entries. The matching projection has 14 indexes, 26 entries
and watermark 16. Source and restored trees together read 44,220 file bytes.
The restored Authority then preserves owner/session identity, retained message
ID, forever policy, denied revoked session, exact attachment bytes and unknown
state. A write only on the replacement survives its next restart. The original
source is never restarted after restore. Owned processes and scratch state
are removed in the finalizer.

Execution: dotRonin, `/home/ironin/wabi`, branch
`codex/security-boundary-hardening-20260930`, base HEAD `138abe39` with shared
uncommitted changes. Exact server/snapshot digests are in the receipt. The
sandbox refused local port binding with EPERM before fixture launch; the
authorized loopback rehearsal then passed under reviewed execution. No network
configuration, production data or remote service changed.

## Remaining verifier requirements

This advances package 3 in the master plan; it does not complete it. The
rehearsal is stopped V1, same computer and same binary, not a live V2 standby
promotion or clean physical-machine recovery. Full permission/room-policy
coverage, deletion/expiry/upload-revocation, protected configuration and active
key overrides, external blacklist, enabled Lore/plugins and other external
stores still need a coordinated inventory and independent restore acceptance.
The small tests' inactive markers are synthetic. The separately recorded Rust
live archive checks exercise actual V2 inactive restore, but this new helper
does not decode/replay the encrypted engine itself. No source/stored prefix
agreement, consensus, fencing or surviving client discovery is invented here.
