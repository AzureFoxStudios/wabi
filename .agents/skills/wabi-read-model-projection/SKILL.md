---
name: wabi-read-model-projection
description: Use when moving a WabiDB projection into the SQLite read model or changing what a read-model handler stores, reads or skips during replay.
---

# Moving a projection into the SQLite read model

Messages (PR #334, Task 3.5.1), channels (#343, 3.5.2) and channel members
(#345, 3.5.3) live in `projections/read-model.sqlite3`; every other projection
still loads from `snapshot.json`. Users (#348, 3.5.4) is an open PR, not
shipped. Status and plan: `docs/plans/2026-11-12-backend-handoff.md`.

Detail lives in `docs/architecture/STORAGE_FORMAT.md` §4.1 and
`docs/ai/wabidb-engine.md`; read both before starting. This skill is the
checklist, not a copy.

## The pattern (copy `channels.rs` / `channel_members.rs`)

All paths under `core/crates/wabidb/src/`.

1. **Table** in `projections/read_model/schema.rs`, plus a row name for the
   projection in `applied_commit_seq` (as `MESSAGES`, `CHANNELS`,
   `CHANNEL_MEMBERS`).
2. **Two numbers** in `schema.rs`, both stored in `read_model_meta`; a file
   with either different is deleted and rebuilt from the log (nothing is
   migrated in place):
   - `SCHEMA_VERSION`: bump when a table, column or index changes.
   - `READ_MODEL_GENERATION`: bump when a record type gets a new version in
     `format::versioned`, or a read-model handler changes what it stores for
     an event (keys, values, which events it applies). Same change, always.
3. **Pin test (tripwire).** Each moved projection has
   `tests::stored_rows_are_pinned_to_the_read_model_generation`: a hash of the
   rows it stores for fixed events, paired with the generation. When it
   fails, bump the generation and update both values together; never the hash
   alone (comment in `projections/channel_members.rs`).
4. **Watermark with the commit.** Rows and `applied_commit_seq` are written in
   one transaction per commit (`ReadModel::finish_commit`). A checkpoint makes
   the read model durable at the watermark before writing `snapshot.json`.
5. **Replay-floor skip.** Startup replay starts at the snapshot, but the read
   model may already hold later commits. The handler's `apply` begins with
   `if event.commit_seq <= state.read_model().replay_floor() { return Ok(()); }`
   (`projections/channels.rs`, `channel_members.rs`, `messages.rs`).
6. **Reads during apply go through the writer**: `state.read_model().write(|conn| …)`
   sees the open transaction's own rows. **Queries outside apply** use
   `read(…)`, which sees committed rows only (`projections/read_model/mod.rs`).
7. **`fn stores_in_read_model(&self) -> bool { true }`** on the handler
   (`projections/handler.rs`). Such handlers read nothing but the read model
   while they apply.
8. **An in-memory projection that writes read-model rows** (user deletion's
   membership cascade) overrides `Projection::apply_to_read_model` so a
   read-model rebuild over commits the snapshot covers applies only that part,
   and skips that part below the replay floor
   (`projections/user_deletion.rs`).
9. **Docs in the same PR**: STORAGE_FORMAT.md §4.1 table list, schema and
   generation history in `docs/ai/wabidb-engine.md` (AGENTS.md: projection
   changes update engine docs).

## Traps (each happened or was caught in review)

- **An in-memory projection that reads a moved projection during replay sees
  LATER state.** When the read model is ahead of the snapshot, the in-memory
  projections replay commits whose rows the read model already moved past.
  Room placement had to skip its same-commit channel check at or below the
  floor (#343; STORAGE_FORMAT.md §4.1). Search every `apply` that reads your
  table before moving it.
- **Two skips that depend on each other.** Membership events and the
  user-deletion cascade must both skip below the floor; re-applying either one
  alone leaves a membership that differs from live (#345).
- **Non-deterministic apply.** Replay must write the same bytes as the live
  run. A wall-clock stamp in a handler breaks that; #343 gives rows an update
  creates creation time 0 for this reason.
- **Full-table scan on a hot path.** #345 replaced a scan of every membership
  on each socket join with an indexed `user_id` column (8.9 ms to 12 µs at
  50,000 memberships; `tests::read_model_channel_members::measure_channel_ids_of_user`).
- **Two open PRs taking the same generation number.** #349 took generation 4
  while #348 was open, so #348 uses 5 (handoff note). Rebase and re-check the
  number (and the pin hashes) before merging.
- **Old data directories** are not supported across these moves: wipe them
  (STORAGE_FORMAT.md §4.1, "Directories written before this change").

## Tests every such PR needs

Name them after the existing ones in `src/tests/read_model_channels.rs` and
`read_model_channel_members.rs`:

- delete the SQLite file and reopen: reads unchanged
  (`deleting_the_read_model_file_changes_no_*_read`);
- a file of generation N opened by N+1 is rebuilt, reads unchanged
  (`a_read_model_of_another_generation_is_rebuilt_*`);
- rows and watermark become visible together
  (`a_commits_*_rows_and_its_applied_commit_seq_become_visible_together`);
- a failed startup replay leaves none of its rows;
- read model ahead of / behind the snapshot
  (`a_read_model_ahead_of_the_snapshot_*`, `a_read_model_behind_the_snapshot_*`);
- replay does not re-apply what the read model holds
  (`replay_does_not_reapply_*`);
- power-loss crash between read-model sync and snapshot
  (`tests::power_loss::crash_between_read_model_sync_and_snapshot*`, run with
  `--features test-harness … -- --ignored`, see the `wabi-run-tests` skill);
- a restart matrix of every snapshot/read-model pair compared with live
  (#345's review checked 225 pairs; #348 has a 729-pair matrix);
- a mutation check: replace each replay-floor skip with an unconditional apply
  and show a test fails (#345 did this for both skips).

If a change touches a record's fields, also follow the
`wabi-durable-record-change` skill.
