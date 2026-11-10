# Wabi backend plan (from the 2026-11-06 audit)

Companion to `2026-11-06-backend-audit-wabidb-lore.md`. Finding numbers (W1, L2, ...) refer to that report.

## How to use this document

- Each task is written as a prompt you can paste into a coding session. "Model" says which tier is enough. "You check" is the one thing a human must look at before merging, written so you do not need to read the diff.
- Work on one task per branch and PR. Do not batch.
- Every task that fixes a bug starts by writing a test that fails on `main`. If the agent cannot make the test fail first, the task is not understood yet; stop and ask.
- CI is the reviewer that never gets tired. Phase 1 makes CI strong enough that you can trust green.
- Two reviewers per PR in phases 2 and 4: one Claude session, one GPT session, each told "find a reason this PR is wrong". Merge only when both say it is fine or you understand why one is wrong.

Standing rules to paste at the top of every session (in addition to AGENTS.md):

```
Rules for this task:
1. Write a test that reproduces the problem and fails on main before changing any code. Show me the failing output.
2. Change the smallest amount of code that makes the test pass. No drive-by refactors.
3. Do not edit any file under docs/ unless the task says to. If a doc claim is now false, list it at the end instead.
4. Do not add a feature, module, or abstraction that the task did not ask for.
5. If you are unsure whether a change is safe for existing stored data, stop and say so.
6. End with: the exact test command, its output, and the list of files changed.
```

---

## Phase 0: the decision (1 to 2 weeks, Opus/Fable, you read the result)

**Goal:** choose between keeping the in-memory projections (A) or moving them onto SQLite under the existing `WabiStore` seam (B), based on a measured spike instead of opinion.

**Task 0.1 Spike: messages projection on SQLite.**
Prompt: "On a throwaway branch, keep the WabiDB sequencer, segments, commit index, replay, and encryption exactly as they are. Replace only the `MessagesProjection` storage: instead of SkipMap indexes in `ProjectionState`, write the same events into a SQLite file (`rusqlite`, bundled, WAL mode) with tables for messages and the channel-time index, one transaction per commit, and store `applied_commit_seq` in a table. Keep `WabiStore` method signatures unchanged. Then measure on a generated dataset of 1 million messages across 50 channels: startup time, resident memory after startup, p50/p99 latency of `send_message` and `list_messages_page`. Report both the current engine and the spike side by side. Do not port any other projection."
Model: Opus/Fable. You check: the numbers table, and that the branch is marked throwaway.

**Task 0.2 Write the decision record.**
Prompt: "Write `docs/architecture/ADR-0001-projection-storage.md` using the spike numbers. State the decision (A or B), the three strongest reasons against it, and what would make us revisit it. Under 2 pages."
Model: Opus/Fable. You check: that you agree with the decision after reading it once.

**Decision taken 2026-11-06, recorded in `docs/architecture/ADR-0001-projection-storage.md` (accepted after the spike):** the default is **B**. Keep the WabiDB log as the source of truth; move the read model to SQLite behind the existing `WabiStore` seam, treated as derived and rebuildable. The spike is a check on B, not a coin flip: choose A only if the spike shows B is clearly worse at realistic load (for example, p99 read latency several times worse with no RAM or startup benefit).

Two requirements that come with B:

- a config flag for an in-memory read model (`:memory:` or a tmpfs path) so nothing derived is written to disk when an operator wants that; the plaintext projection checkpoint goes away in every mode;
- privacy comes from retention and the key, not from where the read model lives: "live" rooms stay unwritten and are labelled "not retained"; the bootstrap key gets a passphrase or external-source option (the bootstrap module already supports a passphrase).

---

## Phase 1.0: make `main` green first (added 2026-11-07)

`main` CI has been red since 2026-10-11. Three independent causes, none from the Phase 1 work: a permit-release ordering bug in wabi-consensus that makes one test flaky; recovery-policy tests that write into a world-readable temp root, which the loader correctly refuses; and the desktop-host restore path renaming a directory on Windows while holding a lock file inside it. Tasks 1.0a, 1.0b, 1.0c in the prompts file. Merge these before anything else, then re-run checks on the open PRs.

Status 2026-11-09: 1.0a, 1.0b (PR 281), a second consensus race (PR 284), and the Windows/macOS archive tests (1.0c+d, PR 285) are merged. Merged afterwards: 1.0f WabiDB fsync on Windows (PR 287: directory fsync plus four read-only flush handles; the engine could not open on Windows since 2026-10-30) and 1.0h CI now runs the feature-gated Lore integration tests (PR 288). Found by PR 287's Windows run once the fsync errors were gone: 1.0j WabiDB uses the raw stream id as a directory name and several server streams contain a colon, so the Authority has never started on Windows; needs a reversible encoding with dual decode, prompt in the prompts file. Still open at that point: 1.0g, 1.0e, 1.0i.

Status 2026-11-10: 1.0g merged (PR 291: two test-only wabi-consensus races fixed, 100 of 100 clean runs; one rare port-reuse race in the runtime cluster tests is left unfixed and needs a product change to pass a pre-bound listener, to be scheduled only if it keeps failing CI). 1.0k merged (PR 292: the payments acceptance workflow ran a browser smoke script that was never committed; the step is removed and PROJECT_STATUS says browser acceptance for direct payments is not automated). 1.0j merged (PR 293 at 7f675b8: Windows-safe stream directory names with dual decode; the Windows real-Authority smoke test passes for the first time; forward-only on disk, see BACKUP_AND_RECOVERY.md, Version compatibility). 1.10 merged (PR 295). 1.0e merged (PR 297: the office exports job creates an empty stand-in for the Authority sidecar; that workflow passes for the first time). 1.0i merged (PR 298: the Tauri bundle step retries only on a 5xx helper download, at most twice more). 1.0l merged (PR 301 at 5dff886: the wabi-consensus integration test binaries reuse the library's fork gate; 1 failure in 100 runs before, 200 of 200 clean after). Phase 1.0 is closed. 1.0m merged (PR 304 at 605ab12: wabi-server's unit-test binaries reuse the same fork gate; 1 failure in 200 runs before, a stress test went from 135 and 96 refusals per 4,000 reopens to 0). One known race is left: the port-reuse race. PR 304 measured it at about 1 run in 100 on main (3 in 300, each with a traced `EADDRINUSE` on a reserved address), in wabi-server's `genuine_restart` and `genuine_crash` tests as well as the wabi-consensus runtime cluster tests. That is frequent enough to fail unrelated PRs, so it is now Task 1.0n in the prompts file: the recovery runtime accepts a pre-bound listener, so tests never release a reserved port.

## Phase 1: stop the bleeding (2 to 3 weeks, mostly Sonnet)

These are independent. Each is one PR with a failing test first.

**Status 2026-11-10: Phase 1 is complete.** Every task below is merged to `main`.

| Task | PR | Note |
|---|---|---|
| 1.1 | 277 | |
| 1.2 | 280 | Scope corrected during the task: only an all-zero remainder or an unsealed file's partial final entry is tolerated; anything else fails closed. |
| 1.3 | 287 | Landed with the Windows fsync fixes (1.0f). |
| 1.4 | 278 | |
| 1.5 | 286 | Two admissions around the streamed body, so a slow upload never holds the membership gates. |
| 1.6 | 275 | |
| 1.7, 1.8 | 274 | PR 288 later made `features-full` run the Lore integration tests too. |
| 1.9 | 279 | |
| 1.10 | 295 | Asset-write role required; filename must be exactly `recordings/<one component>` (empty and `.` were accepted before review). |
| 1.11 | 276 | |
| 1.12 | 299 | k-way merge over stream directories; see the two consequences below. |

Two consequences of 1.12 that later work must respect:

- **Replay is stricter.** A stream directory whose indexed records are not in commit order now refuses startup with `Corrupt`; the old code sorted globally and started. No normal write path produces such a directory, but the first start of a build containing PR 299 on real data is the test. Try it on a stopped copy first (`docs/deployment/BACKUP_AND_RECOVERY.md`, Version compatibility).
- **Replay applies while it validates.** The old code validated the whole log, then applied. Now a failure late in the log happens after earlier events were applied. Harmless today, because the read model is in memory and a failed open discards it. It is binding on Task 3.5: a persistent read model must wrap startup replay in one transaction, or delete and rebuild the file on failure.

The memory bound of 1.12 is proven by a test counter (at most two decoded events per stream directory). Nobody has measured process memory at 1,000,000 messages on the new code; do that once before quoting a number.

| # | Task | Finding | Model | You check |
|---|---|---|---|---|
| 1.1 | Reaction removal actually removes. Register `reaction_removed` in `ReactionsProjection`, remove the composite key. Test: add, remove, restart engine, reaction is gone. | W6 | Sonnet | Test name shows "restart" |
| 1.2 | Commit-index torn tail is tolerated. `parse_widx_file` stops at the first entry that fails length or CRC and logs the offset, instead of returning an error. Test: write 3 entries, append 200 zero bytes, engine opens with 3 entries. Second test: truncate mid-entry. | W1 | Opus | Test writes zero bytes, not just truncates |
| 1.3 | Directory fsync after creating a `.widx` file, matching what `SegmentWriter::open` does. | W2 | Sonnet | Diff is under 10 lines |
| 1.4 | Promote endpoint checks membership of `repo_channel_id`, same as `set_binding` does. Test: member of channel X, not Y, promote into Y returns 403 and writes nothing. | L1 | Sonnet | Test asserts no file written |
| 1.5 | Upload bodies are streamed to the temp file with a limit equal to the blob cap, after authorization, not buffered in `Bytes`. Same for `/recordings`. Test: body larger than cap returns 413 and memory does not grow. | L2 | Opus | Test includes a size larger than cap |
| 1.6 | `.wabiignore` and `.loreignore` added to the reserved-name list in `confined_fs.rs`. Test: upload is rejected. | L4 | Sonnet | One-line reserve list change |
| 1.7 | CI job `features-full`: `cargo check -p wabi-server --features full` and `cargo test -p wabi-server --features wabi-lore --lib -- lore`. Needs an empty `frontend/build` or the frontend build step first. | process | Sonnet | Job appears green in Actions |
| 1.8 | CI job `power-loss`: `cargo test -p wabidb --features test-harness --lib tests::power_loss -- --ignored`. | process | Sonnet | Job appears green |
| 1.9 | Batcher liveness in `is_healthy`/readiness, so a dead batcher returns 503. Test: kill batcher task, readiness fails. | W13 | Sonnet | Test exists |
| 1.10 | `/recordings` enforces `can_asset_write_lore` and the blob cap. | L7 | Sonnet | Test exists |
| 1.11 | Idempotency table eviction is O(n log n) per insert past the cap: `evict_for_insert` collects and sorts every record. Replace with an expiry-ordered structure so insert is O(log n). | ADR-0001 (a) | Sonnet | Benchmark shows flat insert cost at 100k entries |
| 1.12 | Replay collects every post-snapshot event into one Vec before applying (`engine/replay.rs` `collected`). Apply in commit_seq order while streaming segments, bounded memory. | ADR-0001 (b) | Opus | Test asserts peak memory or that apply starts before the last segment is read |

---

## Phase 2: delete and tell the truth (1 to 2 weeks, Sonnet with Opus review)

Status 2026-11-10: 2.1 merged (PR 302 at c451d5d, 5,728 lines removed). 2.1b merged (PR 306 at a9ee800: the tombstone table, `SubscriptionEngine`, the per-write `deliver_event` call and the bridge task that could never receive, 1,786 lines). 2.2 merged (PR 305 at 7e30249: the CLI reads the real layout and manifest; `check` and `verify` also match every record against the payload hashes in the commit index, because the sequencer writes records with no payload CRC and a damaged or missing acknowledged record was otherwise reported as ok; not yet run against a long-lived real data directory). 2.4 merged (PR 307 at 8983c6f). 2.6 merged (PR 308 at 9cf7498; not yet seen in a real browser). 2.5 is open as PR 309 (backend removal plus the Lore workspace UI for the removed routes; not yet seen in a real browser). 2.3 runs last. Added: 2.7, triage of the cargo-deny advisories that CI only reports.

Found along the way and still open: `th.json` and `es.json` keep the old timed-retention tooltip; `frontend/src/lib/notes/sharedConversationNotes.ts` shows a raw error string to the user (frontend/AGENTS.md rule 14); `chat/search.ts` does not exclude unreadable encrypted messages, so a search can match their placeholder text.

**Task 2.1 Delete dead WabiDB modules.**
Prompt: "Remove these modules and their tests, and anything that only they used: `subscription/`, `ephemeral/`, `protocol/`, `auth/` (the in-crate token tables), `retention/{key_destruction,tombstone,reaper,compaction}`, `crypto/{double_ratchet,x3dh_handshake,x3dh_identity,dm_envelope,dm_rekey,place_rekey,rekey,re_encrypt,safety_number,device_pinning}`, `replication/{failover,snapshot_shipping,rate_limit,observability,anti_entropy}`, `SyncWorker`, `ReplicaStateMachine`, `commands/membership_revalidation.rs`, `cli/{backup,restore,rebuild_indexes,rebuild_indexes_cmd}`. Before deleting each, grep for callers outside the module and its tests; if there is a production caller, stop and list it instead of deleting. `cargo test --workspace` must still pass. Keep the lib.rs module doc accurate."
Model: Sonnet. You check: the agent's list of "had a caller, did not delete" is empty or you understand each entry.
Revised 2026-11-10: the prompt in the prompts file replaces the one above. The compiler decides what is dead, not a text search, and a type that stored data contains counts as a caller.

**Task 2.1b Two leftovers from Task 2.1 (added 2026-11-10).**
Task 2.1 (PR 302) kept two modules because other code still compiles against them. Both look dead one level further out. `retention/tombstone.rs`: `wabi-server/src/state.rs` builds a `tombstone_table` field that nothing reads. `subscription/`: the adapter calls `engine.deliver_event` after every durable write, but nothing in the workspace calls `subscribe_stream`, so each write does delivery work for no listener. Removing the second one edits the write path in `engine/` and the adapter, which is why it is its own task.
Model: Opus. You check: the report shows the search that proves nothing subscribes, and the write path before and after.

**Task 2.2 Fix or remove the CLI.**
Prompt: "`wabidb-cli check/verify/status` walk `streams/<id>/events` but the engine writes `streams/<kind>/<id>/events`, and `verify` expects a manifest shape the engine never writes. Either fix all three to read the real layout and manifest, with a test that runs them against a directory produced by the real engine, or remove them. `check` must never return ok on a tree with zero segments found."
Model: Opus. You check: the test opens a real engine first.

**Task 2.3 Docs truth pass.**
Prompt: "For each of these files, find every sentence that describes engine behavior and either (a) add a reference to the test that proves it, or (b) change it to say 'planned' or delete it: `docs/architecture/STORAGE_FORMAT.md`, `docs/architecture/PERSISTENCE_MODEL.md`, `core/crates/wabidb/src/lib.rs` module doc, `core/crates/wabidb/src/engine/locks.rs` module doc, `core/crates/wabidb/src/projections/noop.rs`, `docs/addons/lore.md` sections 8.2, 11.2, 14. Do not change code. Produce a table: sentence, file:line, test reference or 'marked planned'."
Model: Sonnet. You check: the table has no row that says "left as is".

**Task 2.4 Retention wording.**
Prompt: "Timed retention is a soft delete: the `message_deleted` event hides the message from the read model and the original ciphertext stays in the segment. Update `docs/PRIVACY_STANCE.md`, `docs/PROJECT_STATUS.md`, and any user-facing retention label in `frontend/src` to say so. Do not claim deletion or key destruction anywhere."
Model: Sonnet. You check: grep for "cryptographic deletion" returns nothing outside git history.

**Task 2.5 Cut Lore host operations.**
Prompt: "Remove `script_runner.rs`, `editor_bridge.rs`, and the mirror export path (`mirror.rs` export, `/mirror`, `/scripts`, `/editor` routes). Keep repository, file, history, lock, token, binding, and import. Update `docs/addons/lore.md` to remove the sections. Tests must pass with `--features wabi-lore`."
Model: Sonnet. You check: the routes are gone from the route table in the audit.


**Task 2.6 Honest state for encrypted messages a device cannot read (added 2026-11-10).**
The client already replaces a message it cannot open with one fixed line, "[Unable to decrypt this end-to-end encrypted message on this device]" (`frontend/src/lib/e2ee.ts`, `undecryptableMessage`). Two things are wrong with it. Every cause looks the same, so a new device that was never given the key reads exactly like a failed signature check. And the wording says "end-to-end encrypted" with no qualifier, which AGENTS.md rule 13 does not allow. Separate the no-key case (this device has no key for that message) from failed checks, show the no-key case once per conversation in plain words, and fix the wording. The text may say only what the client knows: it does not know why the key is missing, or whether another device still has it. No key transfer or backup here; that is Phase 5.
Model: Sonnet. You check: the report lists each failure cause and the exact text shown for it, and says plainly that no browser acceptance was done unless it was.

**Task 2.7 Triage the dependency advisories (added 2026-11-10).**
The CI step "Cargo advisories" runs `cargo deny check advisories licenses sources` with `continue-on-error`, so its findings never block and nobody has gone through them. List every finding, apply the semver-compatible fixes one crate per commit, and for the rest say whether the vulnerable code is reachable. No `ignore` entries and no switch to blocking without the owner's approval.
Model: Sonnet. You check: the report has a row for every advisory and says what was done with each.

---

## Phase 3: make stored data safe to evolve (2 to 4 weeks, Opus/Fable, GPT second review)

This is the phase that protects real users after release. Do not let it be rushed.

**Task 3.1 One versioning pattern for every durable record.**
Prompt: "`ProjectTaskRecord` uses a 5-byte magic prefix plus JSON with a version. Define one shared helper in `wabidb::format` that implements that pattern (prefix, version byte, payload; decode tries each known version). Convert every postcard record type listed in audit finding W8 to use it, keeping a legacy decode path for the current unversioned postcard bytes. For each type, add a golden-bytes test: a hex literal of bytes produced by today's code must still decode after the change. Do one type per commit."
Model: Opus/Fable. You check: there is a golden-bytes test per type and each contains a hex literal captured before the change.

**Task 3.2 Operator repair path for "repair required".**
Prompt: "Add `wabidb-cli quarantine --seq N` that, with the engine stopped and the advisory lock taken, records seq N in a quarantine file the engine reads at replay time to skip that event with a loud log. Wrap replay handler application in `catch_unwind` so a panic becomes a Corrupt error naming the seq. Document the procedure in `docs/deployment/BACKUP_AND_RECOVERY.md`. Test: inject a poison event, startup fails naming the seq, quarantine it, startup succeeds."
Model: Opus. You check: the test names a seq in the failure message.

**Task 3.3 Remove the plaintext projection snapshot.**
Under B the SQLite file is the checkpoint, so delete `projections/snapshot.json` writing and loading entirely. Document that the SQLite read model is derived, rebuildable from the log, unencrypted on disk unless the in-memory flag is set, and created with file mode 0600. Add the in-memory flag here if Task 3.5 has not already. Test: start with the flag, confirm no read-model file exists; start without it, confirm 0600.
Model: Opus. You check: `ls -l` in the test output shows `-rw-------`.

**Task 3.4 Message index keys.** Fix W7 so secondary indexes use the same id as the primary row, with a test that edits and deletes a message and asserts the index entry count.
Model: Sonnet. You check: test exists.

**Task 3.5 If B was chosen: projection migration.** Constraint from Task 1.12 (PR 299): startup replay applies events while it validates the log, so every projection moved to SQLite must be written inside one startup transaction that is rolled back if replay fails, or the file must be deleted and rebuilt from the log on failure. Add a test that injects a replay failure after some events were applied and asserts the SQLite file holds none of them. One projection per PR, in this order: messages (already spiked), channels, channel_members, users, then the rest. Each PR: same behavior tests pass, plus a startup-from-log test that proves the SQLite file can be deleted and rebuilt.
Model: Opus/Fable for the first three, Sonnet after the pattern is set. You check: the "delete the SQLite file and restart" test exists in each PR.

---

## Phase 4: Lore correctness (1 to 2 weeks, Sonnet)

| # | Task | Finding |
|---|---|---|
| 4.1 | Promote: strip leading `/` consistently, capture and restore the current branch, hold `io_gate` across the whole operation. | L3 |
| 4.2 | Revision cache: bounded (keep last N or last X GiB), pruned, removed on delete. | L8 |
| 4.3 | Downloads serve ranges from the confined file handle without a full copy and hash; cache the ETag per revision. | L10 |
| 4.4 | Reject commit messages starting with `-`. | L11 |
| 4.5 | Import never deletes an existing tree; refuse with 409 instead. | L12 |
| 4.6 | Mirror cache validation skips `.mirror-cache` symlinks or refuses at register time, not at restart. | L13 |
| 4.7 | Embedded-mode health check probes the binary; missing `lore`/`git` and bad URLs return 4xx/503 with a clear message. | L15 |
| 4.8 | Capability model: either enforce `lore.view/approve/lock/admin` or remove them from the role editor. | L6 |

---

## Phase 5: only now, new things

Localhost app sharing on top of Tailcat (see audit section 7). Replication beyond "experimental". Anything from the roadmap.

Additional devices for experimental conversation encryption (raised 2026-11-09). Today each device creates its own key and a message is encrypted to the devices registered when it was sent, so a new or second device cannot read earlier encrypted messages and nothing is carried over. That is a property of the design, not a defect in the code. Order of work: (1) Phase 2, honesty (Task 2.6): the client tells the no-key case (this device has no key for a message, as on a new or reset device) apart from a failed check, instead of one generic line for both; (2) here: passphrase-protected key backup, where the client encrypts its device keys under a passphrase only the user knows and stores the ciphertext on the user's own Authority; (3) only if asked for: direct device-to-device transfer with both devices present. None of this may be described as independently verified or operator-blind (AGENTS.md rule 13).

---

## What "done with the backend" looks like

- `cargo test --workspace --features full` green in CI, power-loss harness green in CI.
- Every durable record type has a version and a golden-bytes test.
- `wabidb-cli check` run against a real data directory reports the real segment count.
- No doc sentence describes an engine behavior without a test reference.
- An operator can recover from a poison event without restoring a backup.
- A new contributor can open the read model with a standard tool (SQLite) or read a one-page format doc that matches the bytes on disk.
