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

## Phase 1: stop the bleeding (2 to 3 weeks, mostly Sonnet)

These are independent. Each is one PR with a failing test first.

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

**Task 2.1 Delete dead WabiDB modules.**
Prompt: "Remove these modules and their tests, and anything that only they used: `subscription/`, `ephemeral/`, `protocol/`, `auth/` (the in-crate token tables), `retention/{key_destruction,tombstone,reaper,compaction}`, `crypto/{double_ratchet,x3dh_handshake,x3dh_identity,dm_envelope,dm_rekey,place_rekey,rekey,re_encrypt,safety_number,device_pinning}`, `replication/{failover,snapshot_shipping,rate_limit,observability,anti_entropy}`, `SyncWorker`, `ReplicaStateMachine`, `commands/membership_revalidation.rs`, `cli/{backup,restore,rebuild_indexes,rebuild_indexes_cmd}`. Before deleting each, grep for callers outside the module and its tests; if there is a production caller, stop and list it instead of deleting. `cargo test --workspace` must still pass. Keep the lib.rs module doc accurate."
Model: Sonnet. You check: the agent's list of "had a caller, did not delete" is empty or you understand each entry.

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

**Task 3.5 If B was chosen: projection migration.** One projection per PR, in this order: messages (already spiked), channels, channel_members, users, then the rest. Each PR: same behavior tests pass, plus a startup-from-log test that proves the SQLite file can be deleted and rebuilt.
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

---

## What "done with the backend" looks like

- `cargo test --workspace --features full` green in CI, power-loss harness green in CI.
- Every durable record type has a version and a golden-bytes test.
- `wabidb-cli check` run against a real data directory reports the real segment count.
- No doc sentence describes an engine behavior without a test reference.
- An operator can recover from a poison event without restoring a backup.
- A new contributor can open the read model with a standard tool (SQLite) or read a one-page format doc that matches the bytes on disk.
