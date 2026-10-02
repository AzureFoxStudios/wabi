# Signed checkpoint source and local material acceptance

**Scope:** main Wabi before ERP; local candidate, uncommitted and undeployed.
**Execution:** dotRonin, `/home/ironin/wabi`,
`codex/security-boundary-hardening-20260930`, base
`138abe39e08e400188d1812ed3bfd378df435315`.

## Accepted local consumer/storage package

Actual session **78716** finished with exit **0**:
**64 passed, 0 failed, 5 ignored**, across five result groups. Ignored entries
are owned subprocess entry points invoked by parent process/crash checks.

```sh
CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline --locked -p wabi-consensus
```

[Acceptance receipt](geographic-2026-10-02/source-context-consensus-acceptance.json)
and [source receipt](geographic-2026-10-02/source-context-consensus-freeze.json)
record exact source/lock hashes and compressed source/log artifacts. The receipt
was captured during compilation after correcting its package-list representation;
it is not labeled a before-launch freeze. All 25 consensus source/manifest
hashes and the lock stayed unchanged through final readback. No extra target
tree or newer toolchain was introduced.

The consumer checks canonical community P256 identity, source node, fixed
signature domain, low-S signature, exact archive/inventory/bootstrap/applied
prefix claims, bounded strict parsing and immutable verification results.
Duplicate fields, invalid points/scalars, domain changes and invented allocation
fields refuse. Allocation knowledge is explicitly `unknown`.

Schema-2 signed checkpoint manifests are separate from legacy schema-1
material manifests. Complete 64 KiB chunks retain order; repeated equal chunks
are valid. Exact concatenated bytes/hash, private source identity, quotas,
fresh required-byte readback, file/directory sync, retained lock inode and four
actual signed-manifest SIGKILL publication points are covered. Parent tests own
and reap their child processes and dispose only their temporary trees.

This first material schema admits at most 1,024 ordered chunk references:
at most 64 MiB of logical ciphertext, possibly less under configured quotas.
The operator exporter can produce larger archives, which this consumer then
refuses. Raising only a byte budget does not remove the reference-count limit.
Segmented/hierarchical manifests and large-instance capacity acceptance remain
future work; these checks are not a large-community backup-size guarantee.

Deadline checks reach final certification, including contention and late
publication. Synchronous file work cannot be preempted: a late result never
returns a successful receipt, but complete immutable files can remain. A later
fresh check can establish their local durability. Failed ingestion leaves valid
quota-charged chunks; speculative deletion and automatic garbage collection
are not implemented.

## Failures retained and corrections

[Attempt receipts](geographic-2026-10-02/source-context-attempts.json) retain
the actual failed and intermediate runs instead of replacing their evidence:

| Attempt | Actual result | Follow-up |
|---|---|---|
| Initial source consumer | Compile error before tests | Corrected JSON test value; focused rerun 4 passed |
| Initial signed library | 35 passed, 0 failed, 2 ignored | Exact earlier source/log receipt retained |
| Expanded library 5278 | 36 passed, 1 failed, 2 ignored | Extra fields on an internally tagged unit enum were ignored; strict kind-only deserialization repaired |
| Package 24732 | 37 passed, 1 failed, 2 ignored before later targets | Same-store reopen hit ownership refusal; exact isolated check passed |
| Package 88118 | 64 passed, 0 failed, 5 ignored | Intermediate broad fixture retry subsequently narrowed |
| Package 78716 | 64 passed, 0 failed, 5 ignored | Final actual-lock-contention-only fixture probe; every constructor error still fails immediately |

The fixture probe preserves the lock inode/private metadata and waits only
for actual OS lock contention. A separate held-descriptor test proves immediate
production refusal before release and same-inode reopening afterward. Transient
fork/exec descriptor inheritance is a possible cause of the earlier concurrent
failure, not a confirmed explanation. Production ownership/locking behavior
was not weakened.

## Approved server phase — focused and workspace acceptance passed

Direct human approval in the security chat covers the separate source sidecar,
operator retrieval and existing local consensus dependency. Local source adds:

- an identity accessor while application/engine checkpoint guards are held;
- a typed community signer consuming that identity plus the completed export;
- default-off `WABI_CHECKPOINT_SOURCE_CONTEXT=1` on Linux;
- exclusive private sidecar publication with synced immutable bytes;
- descriptor-confined 16 KiB reads and fresh 64 KiB saved-job validation;
- actual-loopback plus operator-secret retrieval, uncached/redacted responses;
- owned single-read admission that survives caller cancellation;
- separate file/byte reserve, restart classifier and inode-owned cleanup.

Existing V2 metadata, `LiveArchiveReceipt` and `CheckpointJob` schemas are
unchanged. Enabled signing/publication failure is visible as a failed job.
Process-death stages remain quota charged and cannot admit a missing/interrupted
Ready record.

Actual server-focused session **44764** exited **101 before tests**: subsequent
shared notification calls referenced an unregistered `api::push` module. The
notification owner has removed only its incomplete hooks/helper, restoring
the accepted message source without dependency additions. No unrelated
call-site suppression was added here. The UI owner passed six focused
whiteboard checks and released Cargo with frontend build `1305bddd7c8f3af6`
frozen. [Producer startup receipt](geographic-2026-10-02/producer-start.json)
records 5,163 source/build hashes before launch, pinned Rust/Cargo 1.93.1,
the unchanged 638-package graph and `CARGO_PROFILE_TEST_DEBUG=0` to reduce disk
use. Debug assertions and unwind behavior remain enabled.

Default producer unit session **75668** finished with actual exit **0**:
**3 passed, 0 failed, 1 ignored**. Its parent process-death check invokes the
ignored child at four actual SIGKILL publication stages. All frozen hashes
remained unchanged. This includes private immutable publication, collision
preservation, strict receipt binding and corrupted/redirected file refusal.

Integration session **9420** stopped with exit **101 before tests** because
the test-only HMAC root-derivation constructor referenced `Mac` instead of
`KeyInit`. The failed log is retained. Only that fixture changed; the second
before-launch freeze is `e0b4a8c3...`. Corrected session **39884** finished with
actual exit **0**: **16 passed, 0 failed, 0 ignored**, across three targets.
[Focused receipt](geographic-2026-10-02/producer-focused-acceptance.json) binds
actual capture/decrypt/root-derived identity/later-write/local-ingest/operator
checks and the old archive/boundary targets to exact source and executable hashes. The new restart test drops the initial operator router, manager and
Authority, waits only for admitted writers' actual AlreadyRunning lock
contention, reconstructs AppState, verifies the same community and lock inode,
then retrieves the exact original signed context through the full router.
This genuine restart check passed. Full workspace session **79528** then
stopped at compile with exit **101 before tests**: the snapshot CLI test-only
wrapper lacked the existing library state/checkpoint-job aliases. The fix adds
only those test imports and a dynamically derived crash-child module path for
both library and CLI wrappers. Actual CLI session **95047** passed **39 checks,
0 failures, 1 ignored child invoked at four SIGKILL stages**.

Final workspace session **84268** finished with actual exit **0**:
**2,663 passed, 0 failed, 15 ignored, 88 result groups**, using addons and
experimental LiveKit broker flags. The third 5,163-file before-launch source
freeze `a15c45f5...` stayed unchanged through final readback.
[Workspace receipt](geographic-2026-10-02/producer-workspace-acceptance.json),
[CLI receipt](geographic-2026-10-02/producer-cli-acceptance.json),
[final source receipt](geographic-2026-10-02/producer-freeze3.json) and
[exact source contents](geographic-2026-10-02/producer-current-sources.json.gz)
retain the actual outcomes, previous failures and artifact hashes. Ignored
entries include parent-invoked subprocesses and genuinely unrun external
fixtures/discovery documentation; no external two-computer or UI-rendering
acceptance is inferred. The server producer is locally accepted as an
experimental default-off candidate; production deployment is separate.

[Independent security review](geographic-2026-10-02/source-context-independent-security-review.json)
is a separate read-only inspection of its recorded source. It does not replace
runtime acceptance. The historical security run passed 2,635 checks against
source receipt `32c17860...`; it does not certify these later edits.

## Dependency and disk provenance

Only references to existing locked P256 and local consensus were added in
this phase. All 638 original package identities/checksums/versions and the root
manifest/toolchain were preserved at local package acceptance. The
[new preserved-snapshot audit](geographic-2026-10-02/dependency-audit-receipt.json)
reports zero vulnerability matches, four maintenance warnings and two existing
terminal-LRU unsoundness warnings, using RustSec snapshot `9b3a3b73...` from
September 30. It is not current or independent security assurance. The deferred notification delivery introduces no graph expansion.

Owned logs were compressed, compared byte for byte, and their raw temporary
copies removed. Shared targets and other chats’ artifacts were preserved.
The fresh run references 78 test executables totaling 5,223,543,400 bytes,
versus 35,294,480,240 bytes in the earlier owner inventory. No earlier path is
referenced by the current run. [Cleanup comparison](geographic-2026-10-02/workspace-cleanup-comparison.json)
is a candidate list, not proof of exclusive ownership or authorization to
delete shared artifacts. About 32 GiB remains free. Current executables and
shared dependency caches are preserved pending exact obsolete-owner release.

No live state, service, firewall, key, push, merge or deployment changed by
this chat in the producer phase. Tailscale subsequently resumed and SSH to Tim
was verified. Native Lore `ch_460` was identified at revision 8 and a new scoped
progress note was published and read back as revision 9; older source and three
untracked metadata files were preserved. This is documentation publication,
not synchronization of the older native source tree. See the exact
[Lore publication receipt](geographic-2026-10-02/lore-publication.json).

## Remaining full goal

[The original transfer draft](geographic-2026-10-02/material-io-draft.json)
remained unreferenced and uncompiled throughout producer/workspace acceptance.
After the UI owner completed deployment and explicitly released its build slot,
a separate byte-RPC slice began. Its initial transport and whole-consensus tests
passed; real producer integration and fresh full-workspace acceptance remain
separate gates. The [compiled-slice contract](../plans/2026-10-02-checkpoint-byte-rpc-contract.md)
records the actual disk-store/roster binding, strict authenticated peer reply,
read/reseed and cancellation-safe worker requirements. The earlier source3
acceptance is historical evidence and does not cover these new bytes.

A historical community signature is not current source-role proof, payload
encryption/replay proof, committed required-byte majority, whole-instance
readiness or writer/nonce permission. Authenticated material transfer and
committed tail/blob availability, independently verified inactive recovery,
complete enabled stores, every mutation/publication fence, safe automatic
Wabi recovery, client continuity, independent regional room owners/selective
fanout, real desktop/media/IP/Tailcat tests and capacity/privacy/operator gates
remain necessary. The geographic card remains In Progress; no HA claim or
Authority activation is enabled.
