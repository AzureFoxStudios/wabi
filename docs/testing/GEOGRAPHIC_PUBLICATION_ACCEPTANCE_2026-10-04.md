# Main Wabi geographic publication acceptance — October 4, 2026

## Scope and current result

This work is for main Wabi before ERP. It tests an optional recovery publisher
against the real Authority router, existing signed checkpoint files and the
fixed-roster recovery runtime. It does not activate a replacement Authority.
Complete-instance readiness and canonical writer permission remain false.

Execution computer: `dotRonin`. Shared checkout: `/home/ironin/wabi`, branch
`codex/security-boundary-hardening-20260930`. The observed shared Git revision
was `c1dd4b8924c12d5be3249957131ba171c705c6f2`; the recovery changes also include
uncommitted files. A Git revision alone does not identify the tested candidate.
The exact frozen source manifests below do.

## Completed fourth disposable Ronin run

| Check | Actual outcome |
| --- | --- |
| Pinned, locked Authority compilation | Passed; normal server, library test and integration test executables identified and hashed |
| Publication ownership tests | 6 passed, 0 failed, 0 ignored |
| Operator admission tests | 6 passed, 0 failed, 0 ignored |
| Source-context tests | 10 passed, 0 failed, 1 ignored internal child helper |
| Two sweep lifetime regressions | Not executed: runner refused duplicate discovery matches |
| Genuine configured publication integration | Not executed |
| Frozen input audit | No changed inputs; no audit errors |
| Actual subprocess drain | Completed before collection and cleanup |

The two sweep definitions appeared under both `socketio_impl` and the nested
`socketio::socketio_impl` module. The runner used substring matching and found
four names. Refusing that mismatch was a runner failure, not four passing tests.
The fix selects the original exact names and executes each with `--exact`.
Each must report one pass, no failures and no ignored cases.

The complete archive contains 182 verified entries, 38,658,834 original bytes
and 55 drained owned intervals. Compressed size is 4,221,521 bytes; SHA-256:
`1b35fd6413b691cfe83fa9d48c13102d805575e5b66e672659082bb467ea61dc`.
Separate remote collection and terminal receipts matched the saved archive.
Generated fixture keys and data were excluded.

Cleanup removed 3,502,390,213 temporary bytes while holding the original target
lock. A separate check at `2026-10-04T07:17:20.716972+00:00` confirmed the workspace
and original runner/Cargo processes absent. Three exact temporary helpers were
archived before removal. Attempts 2–4 have reclaimed 8,974,721,656 temporary
workspace bytes since the October 4 continuation approval. Live data and global
caches were untouched.

Evidence: [acceptance4](geographic-2026-10-02/publication-authority-remote-acceptance4.json),
[saved archive receipt](geographic-2026-10-02/publication-authority-remote-saved4.json),
[remote cleanup](geographic-2026-10-02/publication-authority-remote-cleanup-actual4.json),
[helper cleanup](geographic-2026-10-02/publication-authority-remote-helper-cleanup4.json).

## Fifth disposable run — compiled, failed fixture setup, cleaned

After cleanup, the independently reviewed durable-admission candidate was
applied to five reserved files with exact prior-hash checks and preserved
originals. It saves and synchronizes the original signed capture intent before
returning HTTP 202, reconfirms original journal records on retry and bounds the
HTTP wait while retaining actual queued/IO ownership. It remains unaccepted.

Source5 freezes 20 files totaling 575,303 bytes. Manifest SHA-256:
`9f7734fae8bf47e86e6e58aeb154d2f4723844502b0fd6bc580629d3038fa993`.
Reviewed runner packet SHA-256:
`6462730d6fbf112bbe93311fd6b8f8260b5ae19a8db80f0d65fce6f5dd001a10`.
Preparation and pinned dependency fetch passed. All twelve pre-build filesystem
regression cases passed; those are runner checks, not Wabi recovery acceptance.

Both Authority and recovery-library compilation passed. The publication library
reported **0 passed, 10 failed, 0 ignored** in 0.06 seconds. Every case failed
at private-root setup with `Ownership`, before its intended behavior. The
fixture temporary path crossed a system home-directory alias. The runtime's
refusal is retained; the runner must pass the physical spelling of the same
pinned private fixture directory. New server units, sweep cases and the
configured integration did not execute.

The complete archive contains 149 verified entries, 27,247,873 original bytes
and 44 drained owned intervals. Compressed size is 3,103,887 bytes; SHA-256:
`183b5a2a0bcff2df998fcfc712a8badc5925230469b9cb09de9cee1701ebad0e`.
Cleanup removed 3,728,431,537 temporary bytes under the original lock, followed
by a fresh workspace/process absence check and exact helper archive/removal.
Attempts 2–5 have reclaimed 12,703,153,193 temporary workspace bytes.

The next run requires both exact sweep tests, the recovery library's publication
tests including the new durability definitions, and the genuine configured
Authority publication contract. It uses a fresh private Ronin workspace, two
compiler jobs, half-duty compilation, thermal/memory controls and bounded
storage. Direct tests run serially. The embedded frontend is an API-only compile
placeholder; this is not browser or desktop acceptance.

Evidence: [source5](geographic-2026-10-02/publication-authority-source5.json),
[adoption5](geographic-2026-10-02/publication-authority-durable-admission-adoption5.json),
[independent runner review](geographic-2026-10-02/publication-authority-remote-staging-root-review10.json),
[prepare5](geographic-2026-10-02/publication-authority-remote-prepare-actual5.json),
[acceptance5](geographic-2026-10-02/publication-authority-remote-acceptance5.json),
[saved5](geographic-2026-10-02/publication-authority-remote-saved5.json),
[cleanup5](geographic-2026-10-02/publication-authority-remote-cleanup-actual5.json).
The pending-inventory proposal remains unapplied until this candidate passes.

## Sixth disposable run — 34 checks passed; configured successor wait failed

Both pinned compilations passed. The recovery publication library passed all
ten cases. The Authority passed six publication-owner checks, six operator
admission checks and ten source-context checks (one internal child helper was
ignored). Both original sweep lifetime regressions ran with exact selection and
passed, bringing the total to **34 passed, zero unit failures, one ignored**.
The normal main binary was compiled and hashed; it was not executed.

The genuine configured integration failed at
`recovery_publication_operator_contract.rs:254`, asserting that the successor
was node 2 or 3. Before this assertion, genuine signed capture, durable intent
before HTTP 202, historical receipt retry, cancelled HTTP waiter reconciliation,
multiple encrypted objects and matching actual follower control projections
executed successfully. The original Authority halted. The fixture then accepted
followers' briefly cached agreement on retired node 1 before the replacement
election completed. A bounded fixture-only correction waits for an explicitly
surviving leader, retaining the original assertion and readiness checks.
Production election and permission rules are unchanged. Restarted-follower,
minority, writer-fence and bounded queued-shutdown clauses after the failure have
not passed; the full configured contract remains unaccepted.

Source5 and the twenty source hashes remained frozen. The complete archive has
248 independently verified entries, 56,253,415 original bytes and 77 drained
owned intervals. Compressed size is 5,964,078 bytes; SHA-256:
`0ac12987f1f0fbd5c20c00ee20f7e3d6fed5348b80d9ea5445e50a2bb1684172`.
Separate terminal and collection receipts matched. Generated keys/data were
excluded. Cleanup removed **3,775,234,692 temporary bytes** while holding the
original target lock. Fresh SSH inspection confirmed the root and original
runner/Cargo processes absent. Three exact helper sources were archived and
verified before removal. Attempts 2–6 have reclaimed **16,478,387,885 temporary
workspace bytes**; this is cumulative removal, not a current disk-size claim.
Live state and global caches were untouched.

Evidence: [acceptance6](geographic-2026-10-02/publication-authority-remote-acceptance6.json),
[saved6](geographic-2026-10-02/publication-authority-remote-saved6.json),
[cleanup6](geographic-2026-10-02/publication-authority-remote-cleanup-actual6.json),
[fresh absence](geographic-2026-10-02/publication-authority-remote-cleanup-fresh6.json),
[helper cleanup](geographic-2026-10-02/publication-authority-remote-helper-cleanup6.json),
[unapplied fixture proposal](geographic-2026-10-02/publication-authority-successor-fixture-candidate1.json).

## Seventh disposable run — configured publication passed and cleaned

The reviewed fixture-only successor wait was applied to two files with exact
prior-hash checks. Production source5 was unchanged. Source6 freezes twenty
files, 576,256 bytes; SHA-256:
`ad656ca4a58d6c27ac23caf83a816629bbf9d09b4c96d153e84aa6f12deb8867`.
Both pinned compilations passed. All prior unit groups and both exact sweep
regressions passed, and the full genuine configured integration passed:
**35 passed, zero failed, one ignored internal helper**.

The genuine test covers signed Ready exports, persisted Ready fallback outside
bounded UI history, synced original intent before HTTP 202, identical historical
retry after restart and without a live majority, actual matching follower
checkpoint commands and encrypted material objects, fresh-operation refusal on
a follower/minority, cancellation of an HTTP waiter, three-second paused
admission refusal with original Authority/engine lease retained until actual
drain, and durable local writer-fence refusal. It preserves original source,
archive, journal and advisory-lock identities. It does not restore a complete
enabled instance, kill a configured Wabi process mid-publication, activate a
replacement Authority or prove physical-site survival.

The SSH transport ended with code 255; the original remote runner had already
finished successfully at `2026-10-04T09:10:52.918296+00:00`. A pinned independent
read recovered its actual terminal receipt; complete collection verified it
against the original remote receipt. No replacement run or reboot inference
was made. The archive contains **263 verified entries, 62,110,773 original bytes
and 82 drained owned intervals**. Compressed size is **6,553,097 bytes**, SHA-256:
`9d590dec76dee8a70adbc246d4c87f508530f6eca3d5e3e0026c50bb9e1ab159`.
The source audit found no changed inputs or audit errors. The normal main binary
was compiled and hashed, not executed; UI/media acceptance remains separate.

Original-lock cleanup removed **3,766,798,997 temporary bytes**. Fresh SSH checks
confirmed the root and original runner/build/cleanup processes absent. Three
exact helper sources were archived before removal. Attempts 2–7 cumulatively
reclaimed **20,245,186,882 temporary workspace bytes**. Live data and global
caches were untouched; no run7 build slot remains reserved.

After that acceptance and cleanup, the independently reviewed pending-inventory
proposal was applied to two reserved recovery-library files. It preserves
unfinished original IDs/stages and excludes only exact validated committed
history. This new candidate is **uncompiled and untested**. The automatic
scheduler remains an unapplied source draft with further acceptance gates.

Evidence: [source6](geographic-2026-10-02/publication-authority-source6.json),
[acceptance7](geographic-2026-10-02/publication-authority-remote-acceptance7.json),
[saved7](geographic-2026-10-02/publication-authority-remote-saved7.json),
[transport distinction](geographic-2026-10-02/publication-authority-remote-run-recovered7.json),
[cleanup7](geographic-2026-10-02/publication-authority-remote-cleanup-actual7.json),
[fresh absence](geographic-2026-10-02/publication-authority-remote-cleanup-fresh7.json),
[helper cleanup](geographic-2026-10-02/publication-authority-remote-helper-cleanup7.json),
[pending adoption](geographic-2026-10-02/publication-authority-pending-inventory-adoption1.json).

## Lore comparison before publication

Read-only Tim inspection found the native source repository at
`/home/tim/Desktop/Wabi/data/wabi-server/lore/1120`, repository
`01a041f5628a7640bb6f1a78ff3555a2`, branch `main`, revision **10**, signature
`3ab30db899044de34363aa8278f28343cfe7321bb588cea2a145cc6b7208302c`.
Earlier records map it to channel `ch_460`; fresh disk inspection verifies the
repository/revision, rather than a current authenticated channel-binding read.

Revision 10 records an Office source export from Git
`0b82cec796061d274b22655d16f24ca29720c7c3`. Revision 9 is the earlier geographic
documentation update. The current recovery runtime/publication source files
and this operator runtime document are absent from the native source tree.
Its retained `.git` pointer names a different local worktree and is not a usable
Git checkout on Tim. No `.wabi-sync.json` or synchronization baseline exists in
either this checkout or the inspected native repository.

The separately named source mirror's directory `3219` currently has an empty
`.mirror-cache`; its historical Git head cannot be reported as a fresh result.
The handshake fixture at `3227` is a different repository and remains at revision
1, signature `2e9d540ea26d1286b0fdd2453d8d00e9fc80234752ef7b6fc8bf4f8e66adcafd`.

Any publication must preserve the Office export, custom files and Lore metadata.
This dated report is an additive documentation update; it is not source
synchronization, deployment or a change to repository bindings. Record the
resulting Lore revision only after exact-file staging, commit and readback.

The additive Lore report and eleven selected receipt copies were committed as
revision **11**, signature
`c5b4ec84ba3e7ab8e895a70762263db778096ffc9c1c0e8241b5e1158594e7fa`.
The exact stage contained twelve added files and one added directory, with no
modified/deleted/moved files. Fresh status/revision checks preceded the commit;
status, history, all twelve content hashes and three existing metadata hashes
were verified afterward. The receipt copies use a new
`docs/testing/geographic-publication-2026-10-04/` directory because the original
evidence directory is root-owned. Its ownership and content were preserved.
No automatic synchronization, source export, deployment or channel-binding
change is implied. The resulting revision and verification are recorded in
[the publication receipt](geographic-2026-10-02/publication-authority-lore-documentation-commit-actual2.json).

The updated report through successful run7 and nine new receipt copies were
published as native Lore revision **12**, signature
`882bad73df0a7c8ef6f063efd21f7a1552e234ee8bee250feb97f86fc9079b95`.
Fresh revision11/status and original owned-report hash/inode checks preceded
writing. The exact stage was one modified owned report and nine added receipts;
no other paths were staged. Immediate staged-status equality preceded commit;
revision/history, all ten hashes and existing metadata were verified afterward.
Revision11 and the earlier Office source export remain preserved. The two exact
completed helpers were archived and removed. This local post-commit revision
note is not automatic synchronization back into the committed report copy.
See [verified publication12](geographic-2026-10-02/publication-authority-lore-documentation-commit-actual3.json).

## Remaining implementation gates

The master [geographic plan](../plans/2026-09-26-geographic-community-nodes.md)
remains unfinished. Next are original pending-job inventory and automatic
reconciliation, real cancellation/crash recovery, surviving byte majority,
retention/reseed and complete enabled-instance restore. Safe writer allocation
must cover every write, encryption/key continuity, rollback and returning old
writers before automatic node-loss recovery is enabled.

Independent regional room ownership and selective cross-region delivery,
three independent physical uplinks with real desktop chat/files/calls, and
bounded roster/presence/load/privacy acceptance are separate required gates.
The 500,000-member discussion remains a sizing model, not measured capacity.

## Attempt 8 — process inventory refusal, fully cleaned

The new source7 snapshot and reviewed packet14 dispatched on Ronin. At
10:09:16 UTC the original runner refused a thread-child inventory that did not
settle within three fresh reads. The consensus compiler was terminated and
actually drained; compilation and tests are **not accepted**. This is a runner
failure, with no source or test failure inferred. The source7 candidate remains
unverified. Saved compiler transitions show a 71°C peak, a thermal hold at or
above 70°C, and resumes below 60°C; no CPU model or manufacturer trip threshold
was recorded.

The [saved archive](geographic-2026-10-02/publication-authority-remote-saved8.json)
contains 110 verified entries, 14,980,936 uncompressed bytes and 31 actually
drained ownership intervals. Its 1,923,065-byte archive SHA-256 is
`a4012916174d9a12a1da00f747d5cfedd4e2ec70129be38c813e61becc5a2f6a`.
Generated fixture identities and data are excluded. Separate original run,
acceptance and collection records matched.

[Cleanup](geographic-2026-10-02/publication-authority-remote-cleanup-actual8.json)
held the original build lock and removed 1,367,936,867 temporary bytes.
[Fresh readback](geographic-2026-10-02/publication-authority-remote-cleanup-fresh8.json)
at 10:21:29 UTC confirmed the root and all 122 recorded original process
identities absent. Three exact helper sources totaling 11,841 bytes were
archived, read back and removed. There is no active attempt8 workspace or
runner. Attempts 2–8 cumulatively removed 21,613,123,749 temporary bytes;
live data and shared caches remain preserved.

The next source-only monitor proposal retains refusal on unresolved ownership,
unsafe reads and malformed inventories. It retries fresh thread lists for at
most 64 attempts with a one-second monotonic retry budget. No partial inventory
is accepted, and existing pidfd, ancestry, subreaper and actual-drain checks are
unchanged. That proposal is not runtime acceptance.

## Attempt 9 — original scheduler attachment passed, fully cleaned

The unchanged 22-file source7 snapshot compiled successfully and passed
**38 checks, zero failures and two ignored helper definitions**. The groups
were consensus publication 10/0/0, publication owners 9/0/1, operator 6/0/0,
source context 10/0/1, the two exact sweep regressions 2/0/0, and the genuine
configured contract 1/0/0. Counts overlap earlier suites. The isolated original
intent child separately passed 1/0/0 and is included through its parent fixture;
it is not an additional top-level pass. Its complete encoded stdout/stderr,
successful exit and unique actual verdict were verified in the original log.
The normal server executable was compiled and hashed, not executed. The embedded
frontend remains an API-only placeholder, with no browser/media acceptance.

The new fixture proves automatic normal-router handling of an original genuine
signed Ready capture whose intent was synchronized through the real runtime
**before router attachment**. Repeated attachment keeps the actual same task;
actual followers apply the matching command/source; original archive, source
and intent bytes/inodes remain unchanged. Queued closure before response
refuses while retaining the original Authority/engine lease, and repeated
shutdown observes actual drain. This is not an intent present before runtime
open, actual collector process kill, replacement Authority activation or HA.

Packet15 used the independently reviewed bounded inventory repair and prior
packet14/scheduler7 reviews. The successor delta was self-audited; an independent
whole-successor receipt was not received while chat coordination was unavailable.
The original run, owner, pidfd, drain, archive and cleanup function ASTs stayed
unchanged. Twelve small mocked inventory retry/refusal checks and the twelve
filesystem checks passed before Git/compiler work. These are separate probe
scopes, not added to the 38-check software total.

The long native SSH connection timed out with exit255. Fresh pinned readback
recovered the **original** runner333174/start37381842 result, accepted and drained
at 11:11:29 UTC, then complete collection independently matched it. No replacement
run or reboot was inferred. The [saved archive](geographic-2026-10-02/publication-authority-remote-saved9.json)
is 6,605,163 bytes, SHA-256
`718e12ab2996dbc7cdc46780bf4d52fa9e591d0f442397ec6e80dc7570a9219e`:
263 verified entries, 62,225,191 uncompressed bytes and 82 drained ownership
intervals. Generated fixture identities/data are excluded.

[Original-lock cleanup](geographic-2026-10-02/publication-authority-remote-cleanup-actual9.json)
removed 3,770,140,299 temporary bytes. [Fresh verification](geographic-2026-10-02/publication-authority-remote-cleanup-fresh9.json)
at 11:19:27 UTC confirmed the root and all 735 recorded original process identities
absent. Three exact helper sources, 11,842 bytes, were archived/read back and
removed. Attempts 2–9 cumulatively removed 25,383,264,048 temporary bytes;
this is not a current disk-size measurement. Live data/shared caches were preserved.

The next test-only original collector crash fixture is prepared but unapplied,
uncompiled and untested. It keeps two actual encrypted voters alive in the parent,
kills/reaps the exact collector at a synchronized genuine Capture intent cut,
then reopens the original tree as a follower with initialization disabled.
Same original data/bytes/locks and safe refusal are required. HTTP202 crashes,
Manifest/Prepared cuts, automatic successful recovery and the full geographic
goal remain open; complete-instance readiness and canonical writer permission
remain false.

### Verified Lore follow-up — revision 13

The native Lore repository `01a041f5628a7640bb6f1a78ff3555a2` on Tim now records the report and nine acceptance/cleanup receipts through run9 in revision **13**, signature `a004a554eca1aa89710eb0d7cf622f0748ca55251316507d71e596df9d4f96ee`. Fresh revision12, original report hash/inode and unstaged state were compared before staging exactly these ten paths. Final history, all ten file hashes and the preserved metadata were verified; both local helper sources were archived and removed. This is documentation publication. The current authenticated channel binding and automatic checkout/source synchronization remain unverified. Run10 is still a candidate-only crash test in progress; no result is asserted.


### October 4: actual original Capture process crash and follower reopen

The [source9 run10](geographic-2026-10-02/publication-authority-remote-acceptance10.json) passed **39 checks, zero failures and three ignored helper definitions**, with both compilations successful and all 23 frozen source inputs unchanged. The two nested successful child checks overlap their parents and are not added again. The normal server executable was compiled and hashed, not executed; the frontend was an API-only placeholder.

The genuine checkpoint fixture killed the exact original collector process with SIGKILL after its original local Capture intent was synced, before normal-router attachment or HTTP 202. Two encrypted control voters survived in the same parent process. Reopening the original WabiDB and publication runtime with initialization disabled preserved the application message and the signed source, encrypted archive, journal and advisory-lock identities. With actual node 2 elected and the original collector now a follower, publication refused with HTTP 503. Original child PID/start identity was independently pinned by the outer owner; the seed had no terminal libtest verdict before SIG9 and the reopened child passed exactly once.

This proves original Capture restart preservation and checkpoint-publication refusal on a follower. It does **not** prove HTTP202 interruption, Manifest/Prepared process cuts, permanent collector/source loss, whole-host loss, successful automatic replacement, or ordinary Wabi writer fencing. The false readiness/writer fields describe gates still unimplemented; opening the original AppState in this fixture does not certify every mutation path.

The complete original archive (6,626,078 bytes; SHA256 `74409fcedf044cf401ac91b6cf60fb2b6a7b6fa6e64c8e4aa7a19108f18f615b`) verified all 263 entries and 82 drained ownership intervals. Original-lock cleanup removed 3,770,711,025 temporary bytes. Fresh 14:00:12UTC verification found the root and all 741 original process identities absent, with no PID reuse. Five local helpers were archived and removed. Geo explicitly released Ronin for one bounded Office/Push successor run under its remaining source/graph/runner gates; no Office execution is inferred. Attempts 2–10 cumulatively removed 29,153,975,073 temporary bytes, not a current disk-size measurement. Shared data and caches were preserved.

The independently reviewed [two-path test adoption](geographic-2026-10-02/publication-authority-genuine-crash-adoption4.json) now matches the exact 23 source9 postimages in the shared checkout. No production source or dependency graph changed. Full enabled-instance restore, every-path writer/key allocation, authenticated client recovery, room locality, three physical uplinks and measured capacity remain open; main Wabi precedes ERP.

### Verified Lore follow-up — revision 14

The native Lore repository on Tim now records this report and nine run10 source,
acceptance, adoption and cleanup receipts in revision **14**, signature
`a1148d1b5b7355a1ae8617fb507eb24036ff6e24a9b0dc5056d90b61ae0723c8`.
Fresh revision13, the original report hash/inode and unstaged state were compared
before changing exactly ten paths. Final history, all ten file hashes and the
three unchanged repository metadata hashes were verified in the
[actual commit receipt](geographic-2026-10-02/publication-authority-lore-documentation-commit-actual5.json).
The native report redirects seventeen receipt links only to independently
verified existing native copies or the exact new receipt paths in this update;
other historical links are preserved. Both temporary local publishing helpers
were archived, read back and removed. This remains documentation publication,
with no source synchronization, deployment or verified current authenticated
channel binding.

### Later process cuts — private untested source

[Candidate2](geographic-2026-10-02/publication-authority-stage-cut-candidate2.json)
defines genuine Ready/Manifest and genuine Prepared process-cut cases using a
separately pinned consensus test executable. Intended checks include the exact
original process kill, follower refusal, unchanged original records and an exact
retry after explicit test election. The Authority and two loopback voters remain
in the parent process. These seven overlay files are **unapplied, uncompiled and
unrun**; neither whole-host loss nor automatic recovery is established. Shared
source9 stays frozen while the separately coordinated Office runner is prepared.

[Candidate3](geographic-2026-10-02/publication-authority-stage-cut-candidate3.json)
supersedes one candidate2 child-output path; the other six overlay files remain
unchanged. Bounded buffers retain output on early marker/wait failure and label
incomplete streams. Acceptance requires actual EOF, reader join and no read
error or output-cap breach. Three new output-handling test definitions are
**unrun**, and all seven effective overlay hashes were read back. This source
repair adds no accepted crash result. No compiler, remote operation or shared
source change was made for either candidate.

### Directory capacity — private storage candidate

The [roster cursor candidate](geographic-2026-10-02/community-roster-cursor-candidate1.json)
adds a separate internal page method over the existing ordered users index.
It seeks after a numeric user ID and bounds each call to 100 results, 256
decoded records, 1 MiB of decoded postcard input and 64 KiB per examined row,
with at most one undecoded lookahead. Empty filtered batches can have a
continuation; it records the last decoded key rather than the last matching
user, so sparse filters advance. Deleted cursor rows do not prevent seeking.
Examined corrupt, oversized or identity-mismatched rows fail explicitly.

The two private overlay files preserve the existing record layout and legacy
decoder. Twelve regression definitions cover cursor order/deletion, bounded
decode, sparse filters, malformed input, byte budgets, legacy records and
projection snapshot reload. They are **unapplied, uncompiled and unrun**.
This is a live keyset view, not snapshot isolation or an engine replay result.
The internal records contain password hashes: any eventual public endpoint
must construct authorized public views and must not serialize this page.
WabiStore/adapter/API integration, indexed search, bounded initialization,
presence subscriptions, People/DM/Office UI and measured capacity remain open.

### Office successor — current coordination

Cleanup acknowledged both geographic candidates as deferred private work
outside the Office 47-path freeze. One Office successor remains first in
Geo's Ronin queue; the prior Geo reservation was explicitly released after
verified run10 cleanup. This is queue ownership, not a fresh assertion of
physical host exclusivity. Cleanup is preparing/reviewing the finite
capability probe and full bounded serial runner. No exact final acquisition
packet has been handed over and no compiler was launched by Geo. Actual
resource/network admission is required before the supervised run. All 63
Office backend definitions remain unrun; no overlapping geographic launch
is permitted by this handoff.
