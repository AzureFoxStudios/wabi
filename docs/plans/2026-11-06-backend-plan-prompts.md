# Backend plan: copy-paste prompts, one per session

Companion to `2026-11-06-backend-plan.md` and `2026-11-06-backend-audit-wabidb-lore.md`.

Usage: start a **new** session for each task, paste the **preamble** first, then the **task prompt**. Suggested model is noted on each. "You check" is the one thing to look at before merging. Open one PR per task.

---

## Preamble (paste at the top of every session)

```
Read AGENTS.md and docs/plans/2026-11-06-backend-plan.md before doing anything. Then do ONLY the task I paste after this. Work on the branch this session was assigned; if none was assigned, create a new branch off main named after the task.

Rules for this task:
1. Write a test that reproduces the problem and fails on main before changing any code. Show me the failing output. If the change is CI configuration or documentation with nothing to unit test, say so; the failing CI run is the reproduction and the same job passing on the PR is the proof.
2. Change the smallest amount of code that makes the test pass. No drive-by refactors.
3. Do not edit any file under docs/ unless the task says to. If a doc claim is now false, list it at the end instead.
4. Do not add a feature, module, or abstraction that the task did not ask for.
5. If you are unsure whether a change is safe for existing stored data, stop and say so.
6. Before you finish, run the tests for the crate you changed, plus `cargo test -p wabi-server --features wabi-lore --lib -- lore` if you touched Lore. Run the full `cargo test --workspace` only with `CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 --no-fail-fast` (a plain build does not fit this sandbox's disk). Failures that need a real frontend build, IPv6, or a non-root user are environmental here and pass on GitHub's runners; list them by name and move on. Do not try to build the frontend in this sandbox; its proxy blocks a CDN that `npm ci` needs.
7. End with: the exact test command, its output, and the list of files changed. When the task is done and its tests pass, push the task branch to origin and open one pull request against main, using that summary as the description. Do not push to any other branch. If the plan document named above is not on your branch, say so and continue from this task text; it is on a branch awaiting merge.
```

---

## Phase 0: the decision

### Task 0.1 Spike: messages projection on SQLite (Opus or Fable)

```
TASK 0.1 (throwaway spike, branch name must start with spike/).

Goal: measure what happens if the WabiDB read model moves from in-memory skip-maps to SQLite, changing nothing else.

Keep exactly as they are: the sequencer (core/crates/wabidb/src/sequencer/), stream segments (stream_log/), commit index (commit_index/), replay (engine/replay.rs), encryption, and every WabiStore method signature (engine/wabi_store.rs).

Change only the storage behind MessagesProjection (core/crates/wabidb/src/projections/messages.rs). Add rusqlite (bundled feature, WAL mode) as a dependency of the wabidb crate. Write the same events the projection handles today into SQLite tables: a messages table keyed by message_id, and a channel-time index table. One transaction per commit. Store applied_commit_seq in a table and use it the same way ProjectionState's watermark is used today. Do not port any other projection.

Then build a benchmark (criterion or a plain binary under core/crates/wabidb/benches/) that generates 1,000,000 messages across 50 channels through the real engine and measures, for both the current engine and the spike:
- startup time from a cold data directory (replay from log),
- resident memory after startup,
- p50 and p99 latency of send_message under 8 concurrent writers,
- p50 and p99 latency of list_messages_page for a 50-message page.

Report the results as one side-by-side table, with the machine specs. Do not try to optimize the spike beyond obvious indexes. Do not merge this branch.
```

You check: the results table exists and the branch name starts with `spike/`.

### Task 0.2 Decision record (Opus or Fable)

```
TASK 0.2.

Read docs/plans/2026-11-06-backend-audit-wabidb-lore.md section 6 and the spike results I paste below.

Write docs/architecture/ADR-0001-projection-storage.md, under two pages. Structure: Context (what WabiDB is today, in three sentences), Decision, the three strongest arguments against the decision and why we accept them, what measured result would make us revisit it, and consequences for the rest of docs/plans/2026-11-06-backend-plan.md.

The recorded default is option B: keep the WabiDB log as source of truth, move the read model to SQLite behind the WabiStore seam, treated as derived and rebuildable, with a config flag for an in-memory read model. Choose A only if the spike shows B is clearly worse at realistic load with no RAM or startup benefit. State which one the numbers support.

Spike results:
<paste the table from Task 0.1 here>
```

You check: you agree with the decision after reading it once.

---

## Phase 1.0: make `main` green first

Found 2026-11-07: `main` CI has been red since 2026-10-11 (last green: 2026-10-02). Three independent failures, none caused by the Phase 1 PRs. Until these land, "merge on green" cannot work, so they go first. After they merge, re-run the checks on the open PRs (they run against the merge commit, so no push is needed).

### Task 1.0a Consensus permit released after "drained" (Opus)

```
TASK 1.0a.

Bug: core/crates/wabi-consensus/src/transport/material/tests.rs::cancelled_caller_retains_admission_store_and_drained_work fails intermittently on CI and locally (assert available_permits() == 1, got 0). Cause, in core/crates/wabi-consensus/src/transport/material.rs around lines 138-156: the Completion guard's Drop body decrements `active` and calls notify_waiters(), which wakes close(); but the OwnedSemaphorePermit is a field of the same guard, so it is released only after the Drop body returns. close() can therefore return while the admission permit is still held. "Drained" does not yet mean "admission slot free".

Fix: make the permit release happen-before the wake. Either hold the permit in an Option and drop it explicitly at the top of Drop::drop before notify_waiters(), or make close() also wait until available_permits() equals the worker count. Keep the public API unchanged.

Test first: on main, run the existing test in a loop until it fails, for example 200 iterations with `cargo test -p wabi-consensus --lib -- transport::material::tests::cancelled_caller_retains_admission_store_and_drained_work` (a shell loop is fine; report the iteration it failed on). Then add a deterministic test if you can construct one (a guard dropped on another thread while close() is awaited, asserting the permit is available the moment close() returns). After the fix, run the loop 500 times with no failure.
```

You check: the report shows a failing iteration number on main and 500 clean iterations after.

### Task 1.0b Recovery-policy tests use a world-readable temp root (Sonnet)

```
TASK 1.0b.

Bug: core/crates/wabi-server/tests/recovery_publication_operator_contract.rs::configured_genuine_publication_preserves_original_receipt_and_refuses_unsafe_retry fails on CI and on any machine with umask 022 with "recovery node configuration ownership refused". Diagnosed cause: core/crates/wabi-server/src/recovery_node.rs::load (around line 195) correctly requires the policy file's parent directory to be owned by the current user with no group/other permission bits. The test writes publisher.json directly into the tempfile::tempdir() root (line 119), and tempfile creates directories with mode 0777 minus umask, which is 0755 under the default umask. The product check is correct; the fixture is wrong. The same layout exists in core/crates/wabi-server/src/recovery_publication_jobs/genuine_restart_tests.rs (around line 370) and genuine_crash_tests.rs (around line 288), which will fail the same way once the consensus test stops masking them in the `cargo test --workspace` job.

Fix: in each affected test or fixture, make the policy file's parent private before writing it. Simplest: in the fixture's Root::new (tests/fixtures/recovery_publication_operator.rs around line 47) and the equivalent root creation in the two lib test modules, call fs::set_permissions(root, 0o700) right after tempdir(). Do not touch recovery_node.rs. Do not loosen the loader.

Test first: run the failing test on main with `umask 022` set in the shell and show the "ownership refused" failure. After the fix it passes with umask 022. Also confirm it still passes with umask 077. Build wabi-server with an empty frontend/build directory if needed.
```

You check: the test passes with `umask 022` in the command.

### Task 1.0c Desktop host restore cannot rename a directory on Windows while holding its lock (Opus)

```
TASK 1.0c. This can only be verified on the Windows CI job (build-tauri windows-latest); say so in the PR and watch that job.

Bug: four tests in src-tauri/src/hosting/archive.rs (lease_blocks_competing_writer_and_keeps_ownership_after_relocation, restore_does_not_move_live_data_even_after_backup_validation, restore_preserves_original_and_rollback_keeps_failed_tree, rollback_refuses_live_restored_or_original_tree_without_moving_either) fail on Windows with "Access is denied (os error 5)" at the fs::rename around line 342. Cause: SnapshotLease::acquire(data) opens the WabiDB lock file inside the data directory and keeps it open, then fs::rename(data, original) moves that directory. Linux permits renaming a directory with open handles inside it; Windows does not.

Fix: on Windows, release the lease's file handle immediately before each directory rename and reacquire it at the new path immediately after, verifying it is the same file (compare the Windows file index or volume serial plus file id, the equivalent of dev/inode) so the "same inode" guarantee the lease documents still holds. Keep the Unix behavior unchanged. If reacquisition fails, the code must stop and report, never continue with the directory moved and no lease. Keep every existing test's assertions; add one Windows-only test that a competing writer cannot take the lock during the release-and-reacquire window if you can make that deterministic, otherwise document the window in a comment and the PR.

Test first: the four tests already fail on the Windows job on main; cite that run. After the fix, the Windows job must be green. Linux job must stay green.
```

You check: the Windows `build-tauri` job is green on the PR.

---

### Task 1.0g wabi-consensus test races (Opus)

```
TASK 1.0g.

Problem: core/crates/wabi-consensus has timing-dependent tests that fail intermittently in CI and locally, on different tests each time. Observed on post-fix code (after PRs 281 and 284 fixed two of them): store::tests::runtime_lease_covers_cancelled_blocking_io_snapshot_owner_and_actual_lock_release ("runtime lease was released before original database lock") and material::checkpoint::tests::certification_contention_and_late_publication_refuse_success_without_deleting_bytes (unwrap on NotFound at material/checkpoint/tests.rs around line 231). Because `cargo test --workspace` runs this crate in both the `test` and `build-server` jobs, every PR has a real chance of a red workspace job regardless of its content. This is the single largest blocker to "merge on green".

Method: run `cargo test -p wabi-consensus --lib` in a loop (at least 40 iterations, with `--test-threads` at the default so the races reproduce) and record every failing test name and its assertion. For each, read the code under test and the test. Decide whether the race is in the product (an ordering the code should guarantee but does not, like the two fixed in PRs 281 and 284) or in the test (an assertion that assumes a scheduling order the API never promised). Fix product races in the product. Fix test-only races by waiting on the real signal the code exposes (a watch, notify, or join) instead of yield_now/sleep; never add sleeps or retries, never loosen an assertion, never mark a test ignored. Each fix is its own commit with the failing iteration count before and 100 clean iterations after. Report the final loop: 100 consecutive clean runs of the whole crate.

If a race is in the product and the fix is not obvious within the test's scope, stop and describe it instead of guessing; durability and lock ordering in this crate are exactly where a wrong guess costs real data.
```

You check: the report shows 100 consecutive clean runs of the whole crate, and each fix names which side (product or test) had the race.

### Task 1.0e "Tauri command and export routing" workflow lacks the server sidecar (Sonnet)

```
TASK 1.0e.

Problem: the workflow .github/workflows/office-native-exports.yml job "Tauri command and export routing" runs scripts/fetch-tailcat-sidecar.sh and then `cargo test --manifest-path src-tauri/Cargo.toml --lib workspace_export`, but the Tauri build script requires both sidecars, and the job fails with "resource path `binaries/wabi-server-x86_64-unknown-linux-gnu` doesn't exist" (seen on PR 285, run 42556435806). It only triggers on src-tauri changes, so it had not been hit.

Fix: do what the build.yml Tauri jobs do before cargo runs in that job (stage or placeholder the wabi-server sidecar; read build.yml to copy the exact step rather than inventing one). Keep the rest of the job unchanged. Verify by pushing a branch that touches a comment in src-tauri so the workflow runs, and show the job green.
```

You check: the job is green on the PR.

### Task 1.0i Tauri bundler helper downloads fail CI on upstream 5xx (Sonnet)

```
TASK 1.0i.

Problem: the build-tauri jobs in .github/workflows/build.yml fail whenever github.com/tauri-apps/binary-releases returns 502 or 504 while the bundler downloads AppRun, linuxdeploy (Linux) or nsis-3.11.zip (Windows). Seen on at least six PR runs on 2026-11-08 and 2026-11-09, always after the release binary built. These failures hide real results.

Fix, smallest first: check whether the Tauri CLI honors a cache or env var for these helper binaries (TAURI_BUNDLER_TOOLS_GITHUB_MIRROR or an equivalent in the pinned tauri-cli version; read its docs for the pinned version rather than guessing). If so, pre-download the helpers with curl --retry in a step and point the bundler at the cache. If not, wrap the bundle step in a bounded retry (at most 3 attempts) that only retries when the log shows the download error, so a real build failure still fails fast. Do not pin to an unofficial mirror. Verify on the PR's Linux and Windows jobs.
```

You check: the PR's Linux and Windows Tauri jobs are green, and the retry or cache is visible in the job log.

### Task 1.0j WabiDB stream directories use the raw stream id, which Windows rejects (Opus)

```
TASK 1.0j. This can only be verified end to end on the Windows CI job (build-tauri windows-latest, step "real Authority smoke test"); say so in the PR and watch that job. Read AGENTS.md golden rules 5 and 9 before touching anything under core/crates/wabidb/src.

Bug: the Authority cannot start on Windows. After PR 287 fixed the fsync errors, the smoke test on PR 287 (run 42572218636, head 306e09f) failed with "I/O error: The filename, directory name, or volume label syntax is incorrect. (os error 123)". Cause: core/crates/wabidb/src/sequencer/mod.rs::stream_events_dir builds streams/<kind>/<stream_id>/events with the stream id verbatim, and several server streams contain a colon, which Windows forbids in file names: "community-roster:v1" (community_roster.rs), "service-access:v1" (api/service_access.rs), "rbac:default-workspace" and "user:{id}" (auth_credentials.rs), "channel_members:{id}", "call_session:{id}", "channels:{id}". At least one is written during first boot. The colon ids date from 2026-10-09 or earlier and the smoke test from 2026-10-30, so this has never worked.

Why this is not a one-line fix: engine/replay.rs reads the stream id back from the directory name (stream_path.file_name()) and derives the stream encryption key from it, so the directory name is semantically the stream id. Existing Linux data trees have raw colons in directory names and must keep replaying byte for byte. The same path is built in cli/dump_stream.rs, cli/tail.rs, cli/decrypt.rs, retention/compaction.rs, retention/key_destruction.rs and snapshots/writer.rs; grep the whole workspace for .join("streams") and route every site through one pair of functions.

Fix: introduce one encode function stream_id -> directory name and its exact inverse, in sequencer/mod.rs next to stream_events_dir. An id encodes to itself only when it is made of [A-Za-z0-9._-], does not end in a dot, and is not a Windows reserved device name (CON, PRN, AUX, NUL, COM1-COM9, LPT1-LPT9, case-insensitive, with or without an extension); that keeps every existing safe directory untouched. Every other id, including those reserved names and trailing-dot names, gets a reversible, filesystem-safe encoding of your choice (percent-encoding of the offending bytes is fine, with the escape character itself always encoded so the mapping stays injective); the result must contain none of < > : " / \ | ? *, no control bytes, no trailing dot or space, and must not itself be a reserved device name. Replay and every reader must accept both the raw and the encoded directory name for the same id (dual decode, like golden rule 5 asks for records). A stream must never be split across two directories: when appending to a stream whose raw directory already exists on disk, keep writing there; encode only when creating a new stream directory. Do not rename or migrate existing directories at open; if you believe a migration is needed, stop and describe it instead.

Tests first, all in wabidb: (1) encode/decode round trip for every colon id above plus ids with each forbidden character, and the Windows-safety properties listed; (2) a fixture tree with a raw "community-roster:v1" directory replays the same events, in the same order, with the same derived key, before and after the change; (3) open that fixture, append one more event to the same stream, reopen, and assert both events replay in commit order from one directory; (4) a fresh tree writes the encoded directory and replays it. Then the Windows job: the smoke test must get past Authority startup. If it fails later with a new error, report the exact message and stop; do not chase it in this PR.
```

You check: the four tests exist and failed or were impossible before the change, the Windows `build-tauri` job's smoke test passes Authority startup, and every `.join("streams")` site in the workspace goes through the one encode/decode pair.

### Task 1.0k "Direct payment acceptance" workflow runs a script that was never committed (Sonnet)

```
TASK 1.0k.

Problem: .github/workflows/payments-acceptance.yml, job direct-payments, step "xvfb-run -a node scripts/payments-browser-smoke.mjs" fails with "Cannot find module .../frontend/scripts/payments-browser-smoke.mjs". That file has never been committed (git log --all shows nothing for it). The step was added in 4a00104 (2026-10-30). The workflow only triggers on its path filter (payments code, Cargo.lock, Cargo.toml, rust-toolchain.toml and a few more), so it had not run on main since; it fired on PR 291 because that PR touches Cargo.lock.

Find out first: check .gitignore for a pattern that hides the script, and read the sibling frontend/scripts/*-browser-smoke.mjs files and the earlier steps of this job to see what the smoke was meant to cover (the env it is given: WABI_PAYMENTS_STATIC, WABI_PAYMENTS_REQUIRE_RAILS, WABI_PAYMENTS_QR_QA, WABI_SMOKE_SERVER_BINARY). Then do one of two things and say which in the PR: (a) if a payments browser smoke is small and the sibling pattern makes it clear what to assert, write it, run it locally against the debug server, and keep the step; (b) otherwise remove the step and the upload-artifact step that depends on it, and add one line to docs/PROJECT_STATUS.md's payments section saying the browser acceptance for direct payments is not automated. Do not leave a step that cannot run. Do not touch the other steps of the job. Verify by pushing a branch that touches Cargo.lock in a harmless way is not acceptable; instead include the workflow file itself in the change, which is in its own path filter, so the job runs on the PR. Show it green.
```

You check: the `direct-payments` job is green on the PR, and the PR says whether coverage was added or removed.

### Task 1.0l wabi-consensus integration tests see a phantom lock owner (Opus)

```
TASK 1.0l. Test-only change in core/crates/wabi-consensus. Do not change production code.

Problem: PR 291 (Task 1.0g) fixed a race in the crate's unit-test binary: a forked child holds copies of every open descriptor until exec, including another test's just-dropped flock'ed store file, so an immediate reopen fails with Ownership. The fix is src/fork_gate.rs, which is #[cfg(test)] inside the library, so the integration test binaries under tests/ do not get it. Seen in CI on PR 298 (run 42756308919, job build-server): tests/storage_contract.rs::identity_and_exclusive_private_root_do_not_silently_reset panicked at storage_contract.rs:74 via :367 with Ownership, while killed_process_preserves_acknowledged_vote_logs_commit_applied_receipt_and_snapshot in the same binary was spawning a child of the test executable (lines 484 and 499). tests/encrypted_tcp_contract.rs also spawns children (four sites) and has the same exposure.

Method: read src/fork_gate.rs and PR 291's description first; the mechanism and the measurements are there. Reproduce before fixing: loop `cargo test -p wabi-consensus --test storage_contract` and `--test encrypted_tcp_contract` (run two copies at once to load the machine, as PR 291 did) and record the failure count and every failing test name.

Fix: give the integration tests the same protection. Put one small gate module under tests/ shared by both files (for example tests/common/mod.rs). Every child spawn goes through it: hold the gate exclusively until Command::spawn returns, and close inherited regular-file descriptors in pre_exec, exactly as fork_gate::spawn does. Every test that opens, drops and reopens a store, or probes a lock, holds the gate shared while it does. Decide whether the shared hold wraps each open or the whole test body, and justify it: the hold must cover every flock acquisition and probe, and must not deadlock a test that both spawns and opens. Do not add sleeps or retries, do not loosen any assertion, do not mark anything ignored. If duplicating the 60-line module is the cleanest way, duplicate it and say so; do not make the library's gate public or compile it into production builds.

Proof: the failure count before, and 100 consecutive clean runs of both integration test binaries under the same two-copy load after. Then run the whole crate once: cargo test -p wabi-consensus.

Also state, without fixing it here: whether wabi-server's own tests that use this crate and spawn children have the same exposure, with the file names.
```

You check: the report gives a failure count before the fix and 100 clean runs after, under the same load.

### Task 1.0m wabi-server unit tests have the same phantom lock owner exposure (Opus, optional)

Found by the Task 1.0l session. Never seen failing in CI, so this is optional; run it only if the server tests start failing with `Ownership`.

```
TASK 1.0m. Test-only change in core/crates/wabi-server. Do not change production code in wabi-server or wabi-consensus.

Background: read core/crates/wabi-consensus/src/fork_gate.rs and the descriptions of PR 291 and PR 301 first. A forked child holds copies of every open descriptor until exec, including a flock'ed consensus store file another test has just dropped, so an immediate reopen is refused with Ownership. PR 291 fixed this for wabi-consensus unit tests and PR 301 for its integration tests. PR 301's session found the same exposure in wabi-server's own unit-test binary: tests in src/instance_archive/source_context_tests.rs, src/recovery_publication_jobs/genuine_restart_tests.rs and src/recovery_publication_jobs/genuine_crash_tests.rs spawn copies of the test executable, while tests in the same binary (those three files plus src/recovery_node/tests.rs and src/checkpoint_jobs.rs) open wabi-consensus stores and runtimes with no gate. It has not been seen failing in CI.

Step 1, reproduce or prove. Loop the wabi-server lib tests that are involved (filter to those modules; run two copies at once for load) at least 100 times and record failures by test name. If nothing fails, do not guess: write a small targeted stress test, as PR 291 did, that shows the mechanism in this binary (a child spawn overlapping a drop-then-reopen of a consensus store). If you can show neither a failure nor the mechanism, stop and report that; do not change anything.

Step 2, fix. Reuse the one gate source file the way PR 301 does (#[path] include under cfg(test); do not copy it, do not make it public, do not compile it into production builds). Every child spawn in the wabi-server unit tests goes through the gate's spawn. The harder half is the shared side: here the stores are opened inside library code that wabi-server production code calls, not by the tests directly. Find the narrowest test-side points that cover every flock acquisition and probe (for example the test helpers that start a recovery node or runtime), hold the gate shared there, and explain why that covers every acquisition and cannot deadlock a test that both spawns and opens. If it cannot be covered from test code alone, stop and describe what would be needed instead of adding a test hook to production code.

No sleeps or retries, no loosened assertions, nothing newly ignored.

Proof: the failure or mechanism count before, and 100 consecutive clean runs of the same loop under the same load after. Then the full wabi-server suite once, listing environmental failures by name as the preamble describes.
```

You check: the report shows the race or its mechanism before the fix, and 100 clean runs after.

## Phase 1: stop the bleeding

### Task 1.1 Reactions cannot be removed (Sonnet)

```
TASK 1.1.

Bug: removing a reaction is persisted but never applied. core/crates/wabidb/src/projections/noop.rs registers "reaction_removed" as a no-op, and ReactionsProjection in core/crates/wabidb/src/projections/reactions.rs only handles "reaction_added" and only inserts. The adapter's remove_reaction in core/crates/wabi-server/src/adapter/mod.rs writes a "reaction_removed" event with a Reaction payload. Result: an un-reacted reaction reappears on the next read and after restart.

Fix: make ReactionsProjection handle "reaction_removed" by removing the composite key for (message_id, user_id, reaction_type), and remove "reaction_removed" from the no-op list. Keep the other no-op registrations as they are.

Test first (must fail on main): through the real engine, add a reaction, remove it, assert list_reactions is empty; then close and reopen the engine from the same data directory and assert it is still empty.
```

You check: the test name or body includes a restart of the engine.

### Task 1.2 Commit-index torn tail is tolerated (Opus)

```
TASK 1.2.

Bug: a torn or zero-filled tail in a commit index file makes the server non-starting. In core/crates/wabidb/src/commit_index/batcher.rs, parse_widx_file loops over entries and calls CommitIndexEntry::decode(entry_bytes)? on any entry whose length field fits in the buffer. After a power loss during flush_batch, the file can end with zero bytes (ext4/XFS delayed allocation). Zero bytes give entry_len = 0, decode returns Corrupt("body too short"), the error propagates through read_all_entries into engine/replay.rs, and WabiDbEngine::open fails. The segment reader (stream_log/segment_reader.rs) handles the same situation by breaking out of the scan; the index reader must do the same.

Fix: in parse_widx_file, when an entry fails the length check or CRC, decide whether the remainder looks like a power-loss tail. Stopping early is allowed ONLY when (a) every byte from that offset to end of file is zero, or (b) the file's header flags say it was never sealed, the claimed entry length is plausible (65 bytes to 1 MiB), and the entry runs past end of file (a partially written final entry; note that after a restart this file is no longer the highest-numbered one, so do not key on file order). In those two cases log the file name and byte offset at warn level and return the entries parsed so far. In every other case return a Corrupt error naming the file and offset, so the engine refuses to start as it does today; an acknowledged commit must never be silently dropped. Do not repair or rewrite the file. Do not change the on-disk format.

Tests first:
1. Write three entries through the real batcher, append 200 zero bytes to the current .widx file, open the engine, assert exactly three entries are read and the engine opens. (Fails on main.)
2. Write three entries, truncate the file in the middle of the third entry, open the engine, assert two entries are read. (Already passes on main; keep it as a guard.)
3. Flip one byte of entry 2 of 3 in a SEALED file; assert open fails and the error names the file and offset. (Fails on main only in message, but documents fail-closed.)
4. In the current file, overwrite the CRC of entry 2 of 3 with garbage so valid bytes follow it; assert open fails.
5. Second restart: crash leaves a partial entry in file 0, restart, commit so file 1 is created, restart again; assert open succeeds and all commits are present.
```

You check: one test asserts open succeeds on a zero-filled tail, and one asserts open fails on a flipped byte in a sealed file.

### Task 1.3 Directory fsync after creating a commit-index file (Sonnet)

```
TASK 1.3.

Bug: core/crates/wabidb/src/commit_index/batcher.rs open_widx creates a new .widx file with create_new, writes the header, and flushes, but never fsyncs the parent directory. The directory is first fsynced in seal_file, which happens after 10,000 entries or clean shutdown. Compare stream_log/segment_writer.rs SegmentWriter::open, which calls fsync_dir right after creating a new segment file. The engine's own storage/fsync.rs explains why the directory fsync is required.

Fix: call the existing fsync_dir helper on the commit-index directory immediately after open_widx creates the file, matching the segment writer. Keep the change under ten lines.

Test first: this cannot be observed with a process-exit test, so add a unit test that opens a batcher in a temp dir and asserts, via a small test hook or by checking the call sequence the same way existing fsync tests in storage/ do it, that fsync_dir is invoked on file creation. If the crate has no such hook, say so and add the smallest one that the existing segment-writer test pattern uses.
```

You check: the diff to `open_widx` is under ten lines.

### Task 1.4 Cross-channel write through promote-from-message (Sonnet)

```
TASK 1.4. Build and test with --features wabi-lore.

Bug: in core/crates/wabi-server/src/api/lore.rs, the promote_from_message handler (around line 921) calls ensure_channel_member for the channel that contains the message, but never for payload.repo_channel_id (around lines 950-957). The only gates on the target repository are the global capabilities lore.stage and lore.commit. So a member of any channel with the Artist role can commit files into a Lore channel they are not a member of, and probe whether paths exist there. The set_binding handler (around line 782) already checks membership of repo_channel_id; promote must do the same.

Fix: after resolving repo_channel_id, call ensure_channel_member(state, repo_channel_id, auth.user_id) before any Lore service call or filesystem access. Return the same error the other handlers return for a non-member.

Test first (must fail on main): real router with WabiDB, two channels X and Y, a user who is a member of X only and has lore.stage, a message with an attachment in X, a Lore repo on Y. POST /api/addons/lore/promote/from-message with repo_channel_id = Y returns 403 and the repo on Y has no new file and no new commit. Look at tests/lore_credential_contract.rs for the existing test harness.
```

You check: the test asserts no file was written on Y.

### Task 1.5 Upload bodies are buffered in RAM before authorization (Opus)

```
TASK 1.5. Build and test with --features wabi-lore.

Bug: in core/crates/wabi-server/src/api/lore.rs, upload_file (around line 1830) and upload_recording (around line 2000) take body: axum::body::Bytes. app_router.rs exempts these two routes from the 2 MiB JSON budget (raw_file_body_route), and the only remaining limit is config.max_body_size, which defaults to 50 GiB. The blob cap (lore.blob_max_size_bytes()) and the membership and capability checks run after the whole body is in memory. Any authenticated account can exhaust server memory with one PUT, and even legitimate uploads hold up to the blob cap in RAM.

Fix: change both handlers to take the body as a stream (axum::body::Body), perform all authorization and the blob-cap lookup first, then stream the body into the private temp file that private_upload_source creates, enforcing the cap while streaming (reject with 413 the moment the cap is exceeded, and remove the temp file). Keep the existing temp-file lifetime and response behavior. Do not change the transport max_body_size.

Tests first (must fail on main):
1. A body one byte larger than the blob cap returns 413 and no file is staged.
2. A non-member's upload is rejected before the body is read. You can prove ordering by sending a body that would exceed the cap from a non-member and asserting 403, not 413.
3. A valid upload under the cap still succeeds and produces the same revision behavior as before.
```

You check: one test sends a body larger than the cap.

### Task 1.6 Reserve the ignore files (Sonnet)

```
TASK 1.6. Build and test with --features wabi-lore.

Bug: core/addons/lore/backend/src/confined_fs.rs has a reserved-name list (.git, .lore, .mirror-cache, .wabi-repo.json, .wabi-mirror-fetched-at, .wabi-publish-*) but not .wabiignore or .loreignore. Any member who can upload can therefore upload a .wabiignore containing "*". list_files then hides every file, the manifest is empty, and the wabi-sync client (crates/wabi-sync/src/sync.rs, the "baseline files that vanished remotely" block) deletes every clean local copy on every member's machine.

Fix: add ".wabiignore" and ".loreignore" to the reserved list in confined_fs.rs so validate_path rejects them for member uploads and deletes. If the server itself seeds these files during import or repo creation (check lib.rs for where they are written), make sure that path still works, because it may bypass validate_path or need an explicit allowance.

Test first (must fail on main): PUT /api/addons/lore/repos/{id}/files/.wabiignore as a member with lore.stage returns 4xx and the file does not exist afterwards. Add the same for .loreignore and for a nested path like sub/.wabiignore.
```

You check: the reserved-list change is one or two lines.

### Task 1.7 CI builds and tests the Lore feature (Sonnet)

```
TASK 1.7.

Problem: no workflow in .github/workflows/ builds wabi-server with the wabi-lore feature. ci.yml runs cargo test --workspace and cargo build -p wabi-server with no features, so the 3,500-line core/crates/wabi-server/src/api/lore.rs and its tests are never compiled by CI.

Add a job to .github/workflows/ci.yml named features-full that, after the same frontend build step the existing jobs use (the rust-embed macro needs frontend/build to exist), runs:
  cargo check --locked -p wabi-server --features full
  cargo test --locked -p wabi-server --features wabi-lore --lib -- lore
Use the same runner, toolchain pin (rust-toolchain.toml), caching and SHA-pinned actions the existing jobs use. Do not change the existing jobs.

Verify locally that both commands pass before pushing (with an empty frontend/build directory if you did not build the frontend).
```

You check: the new job shows green in GitHub Actions on the PR.

### Task 1.8 CI runs the power-loss harness (Sonnet)

```
TASK 1.8.

Problem: the WabiDB crash-injection tests in core/crates/wabidb/src/tests/power_loss.rs are marked #[ignore] and gated behind the test-harness cargo feature, and no workflow runs them.

Add a job to .github/workflows/ci.yml named power-loss that runs:
  cargo test --locked -p wabidb --features test-harness --lib tests::power_loss -- --ignored
Use the same runner, toolchain pin, caching and SHA-pinned actions as the existing jobs. Verify locally that it passes before pushing.
```

You check: the new job shows green.

### Task 1.9 Health reflects a dead commit-index batcher (Sonnet)

```
TASK 1.9.

Bug: in core/crates/wabidb/src/commit_index/batcher.rs, any error from flush_batch inside the batcher task ends the task and closes its channel. After that, every command fails at batcher.submit in sequencer/mod.rs prepare_command, but the sequencer loop keeps running, and is_writer_running in engine/mod.rs only checks the sequencer. So the server's health and readiness endpoints keep returning 200 while every write fails.

Fix: track batcher liveness (for example, a JoinHandle or an AtomicBool set on exit) and include it in the engine's health check so readiness fails when the batcher has exited. Find where wabi-server's readiness endpoint reads engine health and make sure it uses this.

Test first (must fail on main): a wabidb unit test that makes the batcher task exit (inject an error or abort its handle), then asserts the engine reports unhealthy and a subsequent command returns an error. Also assert the error message says the engine halted, not a generic I/O error.
```

You check: the test exists and names the batcher.

### Task 1.10 Recordings upload enforces role and size (Sonnet)

```
TASK 1.10. Build and test with --features wabi-lore. Do this after Task 1.5 is merged, since it touches the same handler.

Bug: upload_recording in core/crates/wabi-server/src/api/lore.rs (around line 2000) only requires membership of the channel named by the Recordings config. It does not check can_asset_write_lore and does not apply the blob cap, and it lets the caller choose the filename including subdirectories under recordings/.

Fix: require can_asset_write_lore like upload_file does, apply the same blob cap, and restrict the filename to a single path component (no separators) with the existing sanitizer.

Tests first (must fail on main): a view-only member of the Recordings channel gets 403; a body over the cap gets 413; a filename containing "/" is rejected.
```

You check: three tests, one per rule.

### Task 1.11 Idempotency table eviction cost (Sonnet)

```
TASK 1.11.

Problem, found by the ADR-0001 spike: core/crates/wabidb/src/commands/idempotency.rs CommandIdempotencyTable stores records in a HashMap keyed by (user, key). Once the table reaches its maximum size, every insert calls evict_for_insert, which first retains non-expired records (a full scan) and then builds a Vec of all records, sorts it by expiry, and evicts the oldest. That is O(n log n) per insert at the cap. In the spike, generating 100,000 messages went from 65 seconds to 52 minutes once the table was full.

Fix: keep the HashMap for lookup, and add a BTreeMap<(expires_at, user, key), ()> or a BinaryHeap of (expires_at, user, key) as the eviction order, maintained on insert and remove, so eviction of the oldest is O(log n) and no full scan happens on the hot path. remove_expired may keep its scan since it runs on a timer, but it must also maintain the secondary structure. Keep the public API unchanged.

Test first (must fail on main as a timing or operation-count assertion): a test that inserts 2x the maximum record count and asserts the total time stays under a generous bound (for example, 200,000 inserts under 2 seconds in release mode, or count calls to the sort via a test hook). Keep the existing eviction tests passing, including "prefers evicting expired over live".
```

You check: the test inserts well past the table cap and asserts a bound.

### Task 1.12 Replay streams events instead of collecting them all (Opus)

```
TASK 1.12.

Problem, found by the ADR-0001 spike: core/crates/wabidb/src/engine/replay.rs replay_projections reads every segment of every stream and pushes every post-snapshot event into one Vec called `collected` (around line 127), then sorts it by (commit_seq, ordinal) and applies. At 1,000,000 messages this holds about 1.2 GiB at peak, regardless of which read model is in use. The reason for collecting is that segment directory order is not commit order, and the global order must be restored.

Fix: apply in commit_seq order without holding every event. The commit index already lists, for every commit_seq in order, the (stream_kind, stream_id, segment, offset, length) of each event (see the `committed` map at the top of the function and the StreamRef type). Iterate the commit index in commit_seq order and read each referenced record directly from its segment at the recorded offset, using the existing segment reader's seek capability or adding one, with a small per-segment read cache so sequential records in one segment are not re-opened. Keep every current check: orphan records are still ignored, every indexed post-snapshot event must still be found and decode, duplicates still fail, and the (commit_seq, ordinal) order is preserved. Do not change the on-disk format.

Tests first: the existing replay tests must pass unchanged. Add one that writes events across three streams with interleaved commit_seqs, replays, and asserts the apply order equals commit_seq order (there is a test handler that records order around line 428 you can reuse). Add one that measures, via a counter in a test hook, that the maximum number of events held in memory at once during replay is bounded by a small constant times the number of streams, not by the total event count.
```

You check: a test asserts a bound on events held in memory during replay.

---

## Phase 2: delete and tell the truth

### Task 2.1 Delete dead WabiDB modules (Sonnet, Opus review)

Revised 2026-11-10: the compiler decides what is dead, not a text search, and stored-data types count as callers.

```
TASK 2.1. Read AGENTS.md golden rule 5 first.

The audit in docs/plans/2026-11-06-backend-audit-wabidb-lore.md found these WabiDB modules have no production caller (only their own tests reference them). They look finished, so the risk is that someone builds on them. Remove them.

Under core/crates/wabidb/src/:
- subscription/ (all)
- ephemeral/ (all)
- protocol/ (all)
- auth/ (the in-crate token tables; real auth lives in wabi-server)
- retention/key_destruction.rs, retention/tombstone.rs, retention/reaper.rs, retention/compaction.rs
- crypto/double_ratchet.rs, x3dh_handshake.rs, x3dh_identity.rs, dm_envelope.rs, dm_rekey.rs, place_rekey.rs, rekey.rs, re_encrypt.rs, safety_number.rs, device_pinning.rs
- replication/failover.rs, snapshot_shipping.rs, rate_limit.rs, observability.rs, anti_entropy.rs, and the SyncWorker and ReplicaStateMachine types
- commands/membership_revalidation.rs
- cli/backup.rs, cli/restore.rs, cli/rebuild_indexes.rs, cli/rebuild_indexes_cmd.rs

Procedure, one module per commit. Do not decide by text search: names like subscription, ephemeral, tombstone, compaction and rekey are also ordinary words and identifiers elsewhere, so grep gives dozens of false hits. Let the compiler decide. Remove the module's `mod` declaration and its files, then run `cargo check --workspace --all-targets` and `cargo check -p wabi-server --features full --all-targets`. If the only errors are in that module's own tests, delete those tests too and it is dead. If any other code fails to compile, that code is a caller: restore the module, do NOT delete it, and add it to a list at the end with the file:line of the caller.

Three things count as a caller even when the compiler is quiet, so check each before deleting:
1. Anything registered in the type registry or projection dispatch table (build_type_registry and what it calls).
2. Any type that is serialized into stored events, records, the commit index or the projection snapshot. Deleting a type that existing data on disk contains is a data-compatibility change; stop and list it instead.
3. Anything reachable from a binary under core/crates/wabidb/src/bin or core/crates/wabi-server/src/bin, or from src-tauri or helpers.

Recent changes to be aware of: PR 287 and PR 293 touched retention/compaction.rs, retention/key_destruction.rs and the cli/ files (fsync handles and stream directory names). That does not make them live; judge them by the rules above. Do not touch sequencer/, engine/, stream_log/, commit_index/ or projections/ except to remove a `mod` line or an import the deletion orphans.

After each deletion remove any dependency in Cargo.toml that nothing else uses, and keep the wabidb lib.rs module doc accurate: remove bullets for deleted modules, do not add new claims. There is no failing test to write first for a deletion; say so, and treat the full suite staying green as the proof.

After all deletions these must pass: `cargo test -p wabidb`, the full wabi-server suite (`CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 cargo test -p wabi-server --no-fail-fast`, listing the environmental failures by name as the preamble describes), `cargo check -p wabi-server --features full`, and `cargo deny check` if it is configured. Report lines of code removed per module and the "not deleted because of a caller" list.
```

You check: the "not deleted" list is empty or you understand each entry.

### Task 2.2 Fix or remove the operator CLI (Opus)

```
TASK 2.2.

Bug: the operator tool core/crates/wabidb/src/bin/wabidb-cli.rs exposes check, verify and status (cli/check.rs, cli/verify.rs, cli/status.rs, plus cli/list_streams.rs, tail.rs, dump_stream.rs). All of them walk streams/<stream_id>/events, but the engine writes streams/<kind>/<stream_id>/events (see sequencer/mod.rs stream_events_dir). On a real data directory, check finds no segments and still returns ok: true. verify deserializes a ManifestSummary with fields format_version, stream_count, segment_count, total_commits, but the engine writes {schema_version, format_version, engine_version, created_at_micros, highest_commit_seq} in engine/mod.rs, so verify always fails with "invalid JSON".

Fix all of them to read the real layout and the real manifest, or remove the commands you cannot make correct. Rules:
- check must return ok: false if it finds zero segments on a tree that has a commit index with entries, and must report the segment count it actually scanned.
- Every command must be read-only and must not take or unlink the advisory lock (AGENTS.md golden rule 9).
- The tests must create a data directory with the REAL engine (open, write a few commands across two stream kinds, close) and then run the CLI functions against that directory. Delete the existing tests that fabricate the layout by hand.
```

You check: each CLI test opens a real engine before running the command.

### Task 2.3 Docs truth pass (Sonnet)

```
TASK 2.3. This task edits docs only. Do not change any code.

For each file below, find every sentence that states what the engine or addon DOES (not what it is planned to do), and either (a) append a reference to the test that proves it, in the form "(test: path::test_name)", or (b) change the sentence to say it is planned, or delete it if it describes something removed in Task 2.1. Use docs/plans/2026-11-06-backend-audit-wabidb-lore.md sections "Documented claims the code does not back" as the starting list, but read the files in full.

Files:
- docs/architecture/STORAGE_FORMAT.md
- docs/architecture/PERSISTENCE_MODEL.md
- core/crates/wabidb/src/lib.rs (module doc comment only)
- core/crates/wabidb/src/engine/locks.rs (module doc comment only)
- core/crates/wabidb/src/projections/noop.rs (doc comment only)
- docs/addons/lore.md sections 8.2, 11.2 and 14

Deliver a table at the end: sentence (shortened), file:line, what you did. No row may say "left as is" unless it already had a test reference.
```

You check: the table has no "left as is" rows.

### Task 2.4 Retention wording (Sonnet)

```
TASK 2.4. Docs and UI labels only; no engine changes.

Fact from the audit: timed retention is a soft delete. The server appends a message_deleted event that hides the message from the read model; the original encrypted record stays in the append-only segment, and the per-stream key is re-derived from the bootstrap key on every start, so nothing is cryptographically destroyed. The "live" retention mode is the only mode where a message is never written.

Update docs/PRIVACY_STANCE.md, docs/PROJECT_STATUS.md, and any user-facing retention label or help text in frontend/src (grep for retention, "forever", "live", "deleted", "cryptographic") so that:
- timed retention is described as "hidden after N days; the encrypted record remains on the server until a future compaction feature exists";
- "live" is described as "not retained", never as private or confidential;
- the phrase "cryptographic deletion" appears nowhere outside git history and the audit document.
Keep AGENTS.md golden rule 13 wording. List every file you changed.
```

You check: `grep -ri "cryptographic deletion" docs frontend/src core` returns only the audit file.

### Task 2.5 Cut Lore host operations (Sonnet)

```
TASK 2.5. Build and test with --features wabi-lore.

Remove the Lore host-operation features that cannot be enabled today and are a remote-execution surface by design: core/addons/lore/backend/src/script_runner.rs, core/addons/lore/backend/src/editor_bridge.rs, and the mirror EXPORT path (the export/push parts of mirror.rs and the /mirror, /mirror/run, /mirror/configs routes). Keep mirror IMPORT (register_external_mirror, ensure_mirror_cache, /mirror/refresh), repositories, files, history, locks, connect tokens, bindings, promote, recordings and import.

Remove the corresponding routes and handlers in core/crates/wabi-server/src/api/lore.rs (/scripts/*, /editor, /editor/sessions), the require_host_operation_owner helper if nothing else uses it, their tests, and the LoreService fields that held them. Update docs/addons/lore.md to delete the sections that describe scripts, the editor bridge, and external export, and remove them from the API reference table. cargo test --workspace and the wabi-lore tests must pass.
```

You check: `grep -n "scripts\|editor\|mirror/run" core/crates/wabi-server/src/api/lore.rs` shows no routes.

### Task 2.6 Honest state for encrypted messages a device cannot read (Sonnet)

```
TASK 2.6. Frontend only. Read AGENTS.md golden rules 2, 3, 7 and 13 first. Do not change the encryption protocol, key handling, the server, or any stored format.

Problem: frontend/src/lib/e2ee.ts, prepareIncomingE2eeMessage. Every failure to open an encrypted message goes through undecryptableMessage and shows the same line: "[Unable to decrypt this end-to-end encrypted message on this device]". So a device that was registered after the message was sent, which is expected and harmless, looks exactly like a failed signature check or a room mismatch, which is not. The wording also says "end-to-end encrypted" with no qualifier; rule 13 requires this encryption to be labelled experimental and never implied to be independently verified or operator-blind.

Do this:
1. List every way prepareIncomingE2eeMessage can fail today (read the code; include what currentRoomKey and getE2eeRoomStatus throw). Sort each into one of two classes: "this device has no key for this message" (the device was not a recipient for that epoch) or "the message failed a check" (signature, room mismatch, unknown sender device, malformed envelope or payload). If a cause cannot be told apart from the error available, say so in the report rather than guessing; put it in the second class.
2. Carry the class on the prepared message as a typed field next to e2eeError, not by matching error strings in components. Preserve message identity exactly as it is (rule 3): do not touch id or clientMessageId handling.
3. Wording. The first class says plainly that this message was sent before this device joined the conversation's experimental encryption and cannot be shown here, and that it is still readable on the device that had the key. The second class says the message could not be verified and is not shown. Neither may say "end-to-end encrypted" without "experimental", and neither may suggest the server cannot read anything. Never render ciphertext.
4. When a conversation contains first-class messages, show one notice for the conversation using the existing notice pattern in the DM view (the w-notice block in DMMessageView.svelte), instead of relying on the repeated per-message line alone. Follow the patterns already in that component; do not add a new store or navigation path.
5. Check every other place that prints the old fixed line or tests for it (search the frontend for the old text and for e2eeVerified) and keep them consistent, including notifications and search indexing, which must keep excluding these messages.

Tests first: unit tests for the classification, one per failure cause, that fail on main because the class field does not exist. Then the change. Run `bun run check` and the frontend unit tests.

Rule 7 applies: say plainly in the report whether you saw this in a real browser. If you did not, say that visual acceptance is still owed; do not describe how it looks.

Report: a table of failure cause, class, and the exact text shown.
```

You check: the table has a row for every cause, and the report says whether a real browser was used.

---

## Phase 3: make stored data safe to evolve

### Task 3.1 One versioning pattern for every durable record (Opus or Fable, GPT second review)

```
TASK 3.1. This is the most important task in the plan. Go slowly. One record type per commit.

Problem: most WabiDB durable records are postcard-encoded structs with no version tag. Postcard decodes a fixed number of fields, so #[serde(default)] does not help with a missing trailing field, and adding, removing or reordering any field breaks replay of every existing data directory. Replay is strict (engine/replay.rs) and a decode failure halts the engine at startup. Only three types have any protection today: MessageRecord (a V0 fallback), UserRecord (a V1 fallback), and ProjectTaskRecord in core/crates/wabidb/src/projections/project_tasks.rs, which uses a 5-byte magic prefix "WPT2\0" followed by JSON with a version. The ProjectTaskRecord pattern is the one to generalize.

Step 1: in core/crates/wabidb/src/format/, add a small shared helper: encode(prefix, version, &T) -> Vec<u8> and decode<T>(prefix, bytes) that checks the prefix, reads the version byte, and dispatches to a per-version decoder the caller supplies; if the prefix is absent, the caller supplies a legacy decoder for today's raw postcard bytes. Unit test it.

Step 2: for EACH of these types, convert encode/decode to the helper, keeping a legacy path that still decodes today's unversioned postcard bytes: ChannelMemberRecord, DmMessageRecord, DmRecipientRecord, DmIdentityRecord, Reaction, Emote, Webhook, UserLayout, WhiteboardDoc, AlbumRecord, AlbumItemRecord, WikiPageRecord, WikiRevisionRecord, ForumPostRecord, IncidentRecord, GalleryWorkRecord, GalleryFeedbackRecord, all Lore*Record types in projections/lore.rs, all Payment*Record types, and finally MessageRecord and UserRecord (fold their existing fallbacks into the helper).

Step 3: BEFORE converting each type, capture golden bytes: write a test that encodes a representative value with TODAY'S code and embed the resulting bytes as a hex literal in the test. After conversion, the test must assert that those exact legacy bytes still decode to the same value, and that a newly encoded value round-trips. Never regenerate a golden literal after the conversion; if it does not decode, the conversion is wrong.

Step 4: an engine-level test that opens a data directory written by main (create it in the test by checking out the pre-change encoder, or by committing a small fixture directory under core/crates/wabidb/tests/fixtures/ generated before your change) and replays it successfully.

Do not change any field of any record in this task. Report the list of types converted and the golden-test name for each.
```

You check: every converted type has a golden-bytes test whose hex literal was captured before the change (ask the agent to show the commit where each literal was added, which must precede the conversion commit for that type).

### Task 3.2 Operator repair path for a poison event (Opus)

```
TASK 3.2.

Problem: when a projection handler fails on a durable event, the engine halts (engine/locks.rs run_dispatcher) and on restart replay fails with "repair required before startup" (engine/replay.rs). A handler panic is worse: it poisons the application lock live and panics inside open() on restart. There is no tool that lets an operator get past a single bad event, so the only recovery is restoring a backup.

Add:
1. In replay, wrap each handler application in std::panic::catch_unwind so a panic becomes a Corrupt error that names the commit_seq and event type, instead of crashing open().
2. A quarantine mechanism: a file global/quarantine.json in the data directory listing commit_seqs to skip. Replay and the live dispatcher skip those events with a warn log naming the seq. The engine refuses to start if the file is present but unparseable.
3. A CLI command in core/crates/wabidb/src/bin/wabidb-cli.rs: quarantine --seq N, which takes the advisory lock (engine/locks.rs try_acquire_process_lock, so it cannot run against a live engine), appends N to the file atomically (temp, fsync, rename, dir fsync), and releases the lock. It must never unlink the lock file.
4. A section in docs/deployment/BACKUP_AND_RECOVERY.md describing the procedure: stop the server, copy the data directory first, read the seq from the startup error, run quarantine, start.

Test first: write a projection handler used only in tests that fails on a specific payload, commit a poison event, close, reopen and assert the error names the seq; run quarantine on that seq; reopen and assert success and that the warn log names the skipped seq. Add a second test for a panicking handler. Add a third asserting quarantine fails while another process holds the lock.
```

You check: the startup error in the test output names a commit sequence number.

### Task 3.3 Remove the plaintext projection snapshot (Opus)

```
TASK 3.3. Do this after the decision record (Task 0.2) is merged.

Problem: core/crates/wabidb/src/engine/locks.rs write_snapshot_locked serializes every projection index, including message content and password hashes, as hex-encoded values inside unencrypted JSON at projections/snapshot.json. It is written on open, on drop, and every 1000 commits. Anyone with the data directory reads everything, which defeats the per-stream encryption of the log.

Under decision B (SQLite read model), the SQLite file becomes the checkpoint. Remove the JSON snapshot writer and loader entirely, and make the engine rebuild from the log plus the SQLite applied_commit_seq. If Task 3.5 has not yet landed for all projections, this task may be blocked; say so and stop.

Also add the in-memory read-model flag: a WabiDbConfig option (and WABIDB_READ_MODEL=memory environment override in wabi-server config) that opens SQLite with ":memory:" so no derived state is written to disk. When the flag is off, create the SQLite file with mode 0600.

Tests: start with the flag set, assert no read-model file exists in the data directory after writes and after close; start with it off, assert the file exists with mode 0600; assert projections/snapshot.json is never created.
```

You check: the test output shows the `-rw-------` mode or an assertion on 0o600.

### Task 3.4 Message secondary-index keys (Sonnet)

```
TASK 3.4.

Bug: in core/crates/wabidb/src/projections/messages.rs, extract_keys (around lines 804 and 840) uses format!("msg_{:x}", event.commit_seq) as the message id for every message_created event when building the messages_by_channel and messages_by_author indexes, but the primary row and the time index use the writer-stamped UUID from the record (the adapter always sets one). message_edited and message_deleted use the UUID. So every message leaves a stale msg_<seq> entry with is_deleted = false that MessagesProjection::compact never evicts, and the author query path can return stale versions. The existing tests around lines 1303, 1450 and 1521 assert the msg_<seq> key, which is why this is invisible.

Fix: use the same id resolution as apply_created (record.message_id if non-empty, else the seq fallback) in extract_keys, so all indexes agree. Update the three tests that assert the old key.

Tests first (must fail on main): create a message with a UUID id, edit it, delete it, run compact, assert the by-channel and by-author indexes each contain zero entries for that message. Add a test that an author query after an edit returns only the current version.

Note: if Task 3.5 has already moved the messages projection to SQLite, this task is instead "make sure the SQLite schema keys all tables by the same id" and the same tests apply.
```

You check: the test asserts an index entry count of zero after delete and compact.

### Task 3.5 Projection migration to SQLite (Opus or Fable for the first three, Sonnet after)

```
TASK 3.5.<n>. One projection per session and per PR, in this order: messages, channels, channel_members, users, then the remaining projections in core/crates/wabidb/src/projections/ one at a time.

Context: ADR-0001 (docs/architecture/ADR-0001-projection-storage.md) chose SQLite as the read model. The spike branch from Task 0.1 shows the pattern for messages. The WabiDB log, sequencer, commit index, encryption and replay do not change. WabiStore method signatures in engine/wabi_store.rs do not change.

For projection <NAME>:
1. Define its tables in a schema module with a schema version; one transaction per commit; applied_commit_seq updated in the same transaction.
2. Port its apply() and every read path the adapter uses (grep core/crates/wabi-server/src/adapter/mod.rs for this projection) to SQL. Keep the Rust types as the API; do not leak rusqlite types out of the wabidb crate.
3. Keep all existing behavior tests for this projection passing unchanged.
4. Add a rebuild test: write data, close the engine, DELETE the SQLite file, reopen, and assert every read returns the same results. This proves the read model is derived.
5. Add a concurrency test if the projection has one today.

Do not port a second projection in the same PR. Do not optimize beyond obvious indexes. Report before/after timings for the projection's existing benchmark if one exists.
```

You check: the "delete the SQLite file and reopen" test is present in every one of these PRs.

---

## Phase 4: Lore correctness (Sonnet; all with --features wabi-lore)

### Task 4.1 Promote path and branch handling

```
TASK 4.1. Build and test with --features wabi-lore.

Bugs in promote_from_message, core/crates/wabi-server/src/api/lore.rs (around lines 950-1100) and the binding handlers:
1. set_binding requires path to start with "/" (around lines 773-778), and the frontend LorePromoteModal.svelte forces it, but target_path is passed with the slash to lore.upload_file, whose sanitize_repo_path rejects absolute paths. So every binding-driven promote fails after all checks pass.
2. mode "stage" creates and switches to a review branch and never switches back, so later uploads by everyone land on it.
3. mode "direct" switches back to the hardcoded "main" instead of the branch that was current.
4. Each switch_branch/upload_file call takes io_gate separately, so readers can see the other branch mid-operation.

Fix: normalize the binding path by stripping the leading "/" at one place (where target_path is built), capture the current branch via current_branch_name before switching, always restore it (including on error, use a guard), and add one LoreService method that performs branch create/switch/upload/switch-back under a single io_gate hold. Fix the same leave-on-review-branch-on-error shape in core/addons/lore/backend/src/lib.rs upload_file's review-branch path (around lines 1223-1306) and approve_review_branch.

Tests first (must fail on main): a binding with path "/assets" promotes successfully; after a "stage" promote the repo is back on its original branch; after a failed upload the repo is back on its original branch.
```

You check: a test asserts the branch name after promote equals the branch name before.

### Task 4.2 Bound and clean the revision cache

```
TASK 4.2. Build and test with --features wabi-lore.

Bug: in core/addons/lore/backend/src/lib.rs, commit_staged (around lines 2018-2023) copies the ENTIRE working tree into <data_dir>/<channel_id>.revcache/<revision>/ on every snapshot commit, upload_file adds one file per commit, nothing prunes the cache, and delete_repo (around lines 866-887) removes <data_dir>/<channel_id> but not the revcache. A 5 GB channel with 50 snapshots uses 250 GB, and "deleted" content stays servable by revision hash.

Fix: (1) delete_repo removes the revcache directory; (2) add a configurable bound on the revcache (default: keep the newest 20 revisions per repo) and prune after each commit; (3) commit_staged copies only files whose etag changed since the previous revision, hard-linking unchanged files when the filesystem allows (fall back to copy). Keep reads by revision working for retained revisions and return 404 for pruned ones.

Tests first: delete_repo leaves no <id>.revcache directory; 25 snapshot commits with a bound of 20 leave 20 revision directories; a pruned revision returns not-found rather than a 500.
```

You check: a test counts revision directories after pruning.

### Task 4.3 Range downloads without a full copy

```
TASK 4.3. Build and test with --features wabi-lore.

Bug: download_file in core/crates/wabi-server/src/api/lore.rs (around lines 2228-2247) copies the whole file to a private temp file and SHA-256s the whole thing for the ETag on every request, including every Range request. Scrubbing a 1 GB video means a full copy and hash per seek, all under the global io_gate.

Fix: compute and cache the ETag per (repo, path, revision) once (store it next to the revcache entry or in a small sidecar), and for Range requests read only the requested byte range from the confined file handle that open_content_file returns into the response, keeping the existing confinement and the rule that the io_gate is held only while the handle is opened, not while bytes stream to the client. Full downloads may keep the private-snapshot approach if removing it changes the security story; if so, say why.

Tests first: a Range request for 1 KiB of a 50 MiB file completes without creating a 50 MiB temp file (assert temp dir size); the ETag for the same revision is identical across requests and is not recomputed (use a counter in a test hook).
```

You check: the test asserts temp-directory size or file count during a Range request.

### Task 4.4 Reject commit messages that look like flags

```
TASK 4.4. Build and test with --features wabi-lore.

Bug: core/addons/lore/backend/src/lib.rs passes the user-supplied commit message as a bare CLI argument, &["commit", message], in three places (around lines 1264, 2002, 2065). A message starting with "-" (for example "--help") is parsed by the lore binary as a flag; the command exits 0 without committing, parse_revision_from_output returns an empty hash, and the API reports success with revision "".

Fix: add sanitize_commit_message next to sanitize_revision_arg: non-empty, at most 4 KiB, no control characters other than newline, and must not start with "-". Apply it in all three places and in the API handlers that accept a message. Also make the API return an error, not success, when the parsed revision hash is empty.

Tests first (must fail on main): a message "--help" is rejected with 4xx before any CLI call (use the existing stub lore binary in the tests); an upload whose stub returns no Signature line results in an error, not a success with an empty revision.
```

You check: two tests, one for the leading dash and one for the empty revision.

### Task 4.5 Import never deletes an existing tree

```
TASK 4.5. Build and test with --features wabi-lore.

Bug: core/addons/lore/backend/src/lib.rs import_from_git (around lines 2518-2523) runs remove_dir_all on <data_dir>/<channel_id> whenever the channel has no live registration but the directory exists. That is exactly the state after detach_repo ("working tree kept") or after a tree was skipped at boot by the safety check, so an import wipes real assets.

Fix: if the working tree exists and is non-empty, refuse the import with a conflict error that says the tree must be removed or re-attached first. Never delete it. Return 409 from the API.

Test first (must fail on main): detach a repo with files, call import for the same channel, assert 409 and the original files still exist.
```

You check: the test asserts the original files still exist.

### Task 4.6 Mirror cache symlinks do not brick the channel

```
TASK 4.6. Build and test with --features wabi-lore.

Bug: core/addons/lore/backend/src/confined_fs.rs validate_tree(importing=false) recurses into every directory including .mirror-cache, and fails on any symlink. At startup, load_existing_repos in lib.rs (around lines 574-577) calls validate_cli_tree for every repo and skips the repo on error. A mirror of any upstream repository that contains a symlink (very common) works until the first restart, then disappears from the channel, and re-registering fails the same way.

Fix: validate the mirror cache at registration and refresh time with a mode that tolerates symlinks inside .mirror-cache (they are never served; reads go through the confined handle which already refuses symlinks), and exclude .mirror-cache from the startup validate_cli_tree walk. Do not relax validation for the working tree itself.

Test first (must fail on main): register a mirror from a local git repository containing a symlink (the git bridge tests show how to serve one), restart the engine/service, assert the repo is still registered and a normal file in it is readable while the symlink path returns not-found.
```

You check: the test restarts the service.

### Task 4.7 Fail clearly when dependencies are absent

```
TASK 4.7. Build and test with --features wabi-lore.

Bug: in embedded mode, LoreService::health_check in core/addons/lore/backend/src/lib.rs (around line 2156) returns Ok without probing the binary, so main.rs logs "Lore addon initialized" with no lore binary installed and every request is a 500. Missing git, invalid import URLs, and uploads blocked by an ignore rule also surface as 500 "Internal server error".

Fix: health_check runs `<lore_binary_path> --version` in every mode and fails with a message naming the path when it cannot; main.rs already disables the addon on a failed health check. Map these addon errors to proper API responses: missing lore or git at request time -> 503 with "Lore addon dependency missing"; invalid import URL -> 400 with the validation reason; upload blocked by ignore rule -> 422 with "path is ignored by .wabiignore". Add typed error variants in the addon crate rather than matching on strings.

Tests first: health_check fails when the configured binary does not exist; each of the three mappings returns the stated status through the real router.
```

You check: four tests, one per mapping plus the health check.

### Task 4.8 Capability model: enforce or remove

```
TASK 4.8. Build and test with --features wabi-lore.

Problem: core/crates/wabi-server/src/lore_roles.rs defines lore.view, lore.stage, lore.commit, lore.approve, lore.lock, lore.manage-binding and lore.admin, and the role editor lets admins assign them, but handlers only check lore.stage, lore.commit and lore.manage-binding. Locking uses lore.stage, approve/reject use can_edit_lore, and nothing checks lore.view, lore.approve, lore.lock or lore.admin. docs/addons/lore.md section 11.2 describes tiers that do not exist.

Decide per capability and implement: lore.lock gates the lock/unlock routes; lore.approve gates review approve/reject; lore.admin gates repo delete, PATCH, and connect-token administration for other users; lore.view is implied by channel membership and is removed from the editable set (or enforced on every read route if you prefer; pick one and say why). Update the role editor's capability list and docs/addons/lore.md 11.2 to match exactly what is enforced.

Tests first (must fail on main): a user whose role has lore.stage but not lore.lock cannot lock; a user without lore.approve cannot approve; a user without lore.admin cannot delete the repo. Use the existing role-store test pattern in lore_roles.rs and the contract tests.
```

You check: three denial tests, one per newly enforced capability.
