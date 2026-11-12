# Wabi Persistence Model

> **Status:** Canonical reference for how state is stored in Wabi. Truth pass 2026-11-11 (Task 2.3): statements about what the engine does carry a `(test: path::name)` reference; sentences marked *planned* are not implemented.
> **Last major revision:** 2026-06-22 (Wabidb replaces SpacetimeDB).
> **Audience:** Operators configuring retention, contributors adding storage features, and integrators building on the Wabi API.

---

## 1. Philosophy

**Self-hosted, with the server owning the shared state**

The server owns the shared state: channel and message state is written through the operator's WabiDB (other server state, such as sidecar files and uploads, is listed in `docs/architecture/INSTANCE_RECOVERY_INVENTORY.md`), and the operator chooses how long each channel's messages are kept (section 3). The browser client has IndexedDB stores of its own (`frontend/src/lib/storageDb.ts`, which its header comment limits to settings, and `frontend/src/lib/wabidb/queue/db.ts`, an outbound queue). What else the client keeps locally was not checked for this document, and none of it makes the server optional. Wabi is not a client-side-storage design like Signal. Self-host means **their data, their rules, their risk**. (An earlier version of this paragraph said Wabi defaults to client-side storage; it contradicted the tier table below.)

WabiDB's state lives inside the operator's `./data/wabi-server/wabidb/` directory; other server state (sidecar files, uploads) is listed in `docs/architecture/INSTANCE_RECOVERY_INVENTORY.md`. Only one engine process can own a data directory at a time (tests: `tests::integration::two_engines_cannot_share_a_data_dir`, `engine::process_lock_tests::process_lock_excludes_another_engine_and_releases_after_kill`). `wabi-server` reads and writes through the engine. The `wabidb-cli` commands `check`, `verify`, `status` and `list-streams` only read and never take or touch the lock (test: `cli::tests::commands_are_read_only_and_never_touch_the_lock`); `wabidb-cli quarantine` writes `global/quarantine.json` while holding the lock (tests: `cli::quarantine::tests::quarantine_fails_while_the_lock_is_held`, `cli::quarantine::tests::quarantine_appends_once_and_refuses_unindexed_seqs`). `wabidb-cli` has no backup or migration command; a stopped instance is archived with `wabi-instance-snapshot` (`docs/deployment/BACKUP_AND_RECOVERY.md`).

---

## 2. Storage Tiers

| Tier | Default | Who Controls | Purpose |
|------|---------|--------------|---------|
| **Client (IndexedDB)** | Always | User | Personal history, offline access, draft state |
| **Server (Wabidb streams)** | Always | Server admin | Real-time sync, active sessions, shared state |
| **`wabidb::blobs` (BLAKE3 blob writer)** | Not used | n/a | *Planned* for uploads and large media. The writer exists and is tested (`blobs::write::tests::write_is_idempotent`), but nothing calls it: wabi-server keeps uploads in its own registry outside WabiDB (`docs/architecture/INSTANCE_RECOVERY_INVENTORY.md`) |
| **Projection checkpoint** (`projections/snapshot.json`) | Automatic | Engine | Intended to shorten recovery by saving the read model so replay need not start from zero. A restart with the checkpoint present and one without it both give the same state (test: `engine::message_admission_tests::removed_reaction_stays_removed_after_reopen_and_replay`); a checkpoint never claims more than its rows hold (test: `engine::locks::tests::snapshot_never_overclaims_watermark_coverage`). No test shows that replay skips the commits a checkpoint covers or measures replay time |
| **Operator archives** | Manual | Server admin | Offsite backup, disaster recovery; see `docs/deployment/BACKUP_AND_RECOVERY.md` |

All tiers run on the same filesystem. There is no separate database server to provision.

---

## 3. Retention and persistence (what exists)

There is no per-stream persistence mode in WabiDB and no per-stream TOML configuration. Earlier versions of this section described three modes (Ephemeral with a TTL reaper that destroys keys, Session-Only, Persistent) configured by `[streams."..."]` TOML tables, a `wabidb::retention::reaper` module and key destruction on expiry. None of that exists: the reaper and key destruction were removed in PR 302, and no TOML stream table is read. They are *planned* at most.

What the server does today is set per channel, by the server, before the durable write:

- **`live`**: a message sent to a channel in live mode is accepted and is not stored in WabiDB's message read model (test: `core/crates/wabi-server/tests/channel_access_contract.rs::exact_retention_loads_before_requests_and_corruption_cannot_change_live_mode` sets a channel to `live`, restarts, POSTs a message, gets 200, and finds no message with the returned id through `get_message_typed`). That the message is held in the server's session cache is read from `send_message` in `core/crates/wabi-server/src/api/messages.rs` (the `is_live` branch pushes it to `session_messages` and never calls the store), not shown by that test. "Not retained" is not private or confidential: no test covers confidentiality, and none is claimed (AGENTS.md golden rule 13). `durable_delete_waits_for_commit_but_live_delete_remains_session_only` is about deletes and is not cited for this.
- **Timed**: the message is written, and after N days the server's sweep appends a `message_deleted` event that hides it from the read model. The encrypted record stays in the append-only segment until a future compaction feature exists. This is a soft delete. Which messages count as expired is tested (`core/crates/wabi-server/src/api/retention_policy.rs::tests::policy_changes_only_affect_messages_created_after_each_boundary`, `core/crates/wabi-server/src/api/retention_policy.rs::tests::fast_sweep_includes_short_timers_and_excludes_long_or_disabled_channels`). No test checks that the encrypted record is still in the segment after the hide; that sentence rests on reading the delete path in `adapter/mod.rs`.
- **`forever`**: the message is written and not swept.

(The policy files and their loading are covered by `core/crates/wabi-server/tests/channel_access_contract.rs::exact_retention_loads_before_requests_and_corruption_cannot_change_live_mode` and `core/crates/wabi-server/tests/channel_access_contract.rs::socket_retention_persists_exact_modes_and_ignores_unrelated_updates`.)

### 3.1 How a durable write is stored

- Records are appended to per-stream segments at strictly increasing offsets, and the file length after a flush equals the sum of the record sizes (tests: `stream_log::segment_writer::tests::write_multiple_records`, `stream_log::segment_writer::tests::flush_and_close_persist_data`). Neither test checks that an existing record is never rewritten; "append-only" is read from `stream_log/segment_writer.rs`, which has no seek-and-overwrite path.
- Segment records are AES-256-GCM encrypted under the stream's key (tests: `crypto::aes_gcm_record::tests::encrypt_decrypt_round_trip`, `crypto::aes_gcm_record::tests::wrong_key_fails_auth`).
- After the sequencer has finished a command, its response and its commit-index entry are both readable (test: `sequencer::tests::durability_await`; it reads them after the run has ended, so it does not show which came first). Segment records that the commit index does not reference are skipped as orphans (tests: `stream_log::segment_reader::tests::orphan_records_skipped_when_filter_rejects`, `sequencer::tests::orphan_records_tolerated`). `tests::power_loss::simulate_crash_between_segment_write_and_commit_index` is not cited for that: it uses no commit index and shows only that the reader drops what a caller-supplied filter rejects. That the acknowledgment waits for the fsyncs is not shown by any of these; `tests::power_loss::simulate_power_loss_before_fsync` is not cited because its own comment says it checks same-system readability before fsync, not durability.
- The commit index is the canonical ordering of all writes (test: `engine::replay::tests::replay_applies_events_in_global_commit_seq_order`).
- A projection checkpoint is saved every N dispatched commits (`ProjectionState::checkpoint_if_due` in `engine/locks.rs`, called by the dispatcher) and when the engine is dropped (`impl Drop for WabiDbEngine` in `engine/mod.rs`). With N set to 1 the dispatcher writes a checkpoint after a commit (test: `tests::write_completion::failed_apply_stops_the_prefix_and_preserves_the_last_good_checkpoint`: a manual save is refused, yet a checkpoint at commit 1 loads). No test uses a larger N, and nothing measures that it bounds replay time. The save on drop leaves a checkpoint at the last commit (test: `cli::check::tests::quarantine_entry_under_the_snapshot_watermark_is_not_reported` asserts a watermark of 4 after an engine that made four commits is dropped). `engine::locks::tests::snapshot_never_overclaims_watermark_coverage` calls save and load by hand and shows only that a saved checkpoint never claims more than its rows hold. Per-stream snapshots are *planned*; none are written.
- The process-exit crash tests do not discard the operating system's page cache, so fsync ordering is established by code review, not by a test.

---

## 4. File Format

All on-disk formats are specified in `docs/architecture/STORAGE_FORMAT.md`, which gives a test for each behavior. Summary:

| File | Format | Purpose |
|------|--------|---------|
| `*.wseg` | 48-byte header + payload + zero padding to a 16-byte boundary | Encrypted stream segment (test: `format::record::tests::total_size_includes_alignment_padding`) |
| `*.widx` | 16-byte header + entries + 32-byte trailer on sealed files | Commit index file (a new file starts after 10,000 entries: test `commit_index::batcher::tests::file_rotation_at_10000_entries`; the trailer is not read by any test, see `STORAGE_FORMAT.md` §3) |
| `projections/snapshot.json` | JSON | Projection checkpoint (test: `engine::locks::tests::snapshot_never_overclaims_watermark_coverage`) |
| `projections/read-model.sqlite3` | SQLite | The messages projection. Derived from the log, not encrypted, mode 0600 (tests: `tests::read_model_messages::deleting_the_read_model_file_changes_no_read`, `tests::read_model_messages::the_read_model_file_is_owner_only_and_messages_leave_the_snapshot`). Rules: `docs/ai/wabidb-engine.md`, "Messages: the SQLite read model" |
| `*.bin` | raw bytes | BLAKE3 content-addressed blob (no test asserts its path layout; see `STORAGE_FORMAT.md` §5.1). No production caller writes one |
| `*.meta` | three text lines: `blake3=`, `size=`, `created_at_micros=` | Blob metadata sidecar (test: `blobs::write::tests::metadata_sidecar_written`). No production caller writes one |
| `storage-manifest.json` | JSON | Format version and commit watermark (test: `engine::tests::open_creates_storage_manifest` asserts the file exists with `schema_version` 1 and `engine_version` "0.1.0"; an engine-written manifest deserializes into those five fields (test: `cli::verify::tests::real_engine_tree_verifies`); raising the watermark has no test) |
| `global/quarantine.json` | JSON | Commits replay must skip (test: `engine::quarantine_tests::failing_handler_is_named_at_startup_and_quarantine_skips_it`) |

`*.wsnap` files and a binary `BMTA` blob header were described here before; no code writes either (see `STORAGE_FORMAT.md` §4 and §5).

All CRCs are CRC32C (Castagnoli) and all multi-byte integers are little-endian (test: `format::record::tests::round_trip_event`).

---

## 5. Storage Manifest

`$DATA_DIR/storage-manifest.json` holds `schema_version`, `format_version`, `engine_version`, `created_at_micros` and `highest_commit_seq`. It is created on first open (test: `engine::tests::open_creates_storage_manifest` asserts it exists and contains `schema_version` 1 and `engine_version` "0.1.0"). Its five fields are present in what the engine writes: an engine-written manifest deserializes into those five fields (test: `cli::verify::tests::real_engine_tree_verifies`). `highest_commit_seq` is raised when the engine opens and replay finds a higher commit; no test covers the raise (read `update_manifest_high_seq` in `engine/mod.rs`). `wabidb-cli verify` reads it (test: `cli::verify::tests::real_engine_tree_verifies`).

*Planned, not implemented:* a per-stream list and a `config` block in the manifest, and using the manifest as a backup verification artifact ("a backup is valid iff its manifest matches the live data directory"). Nothing compares manifests, and the engine does not refuse to start on a manifest mismatch.

---

## 6. Key Destruction (planned; not implemented)

> **Status:** nothing in the running server destroys stream keys. Timed retention is a soft delete: a `message_deleted` event hides the message and the original encrypted record stays in the segment. The per-stream key is re-derived from the bootstrap key on every start. The text below describes the intended design only.

The planned design is **key destruction** for streams. Everything below this line in this section is design intent, not behavior: rather than overwriting data on disk (slow, fragile on SSDs), the engine destroys the stream's encryption key. The on-disk bytes become mathematically unrecoverable.

**Intended lifecycle (planned):**
1. **Create:** A new stream is allocated with a fresh 256-bit key held in the `StreamKeyRegistry`. (Today the key is derived from the bootstrap key and the stream id on every start, which is why destruction is not possible: tests: `engine::stream_dir_tests::encoded_directory_registers_decoded_key_when_snapshot_covers_records`, `engine::stream_dir_tests::legacy_raw_colon_directory_replays_with_raw_id_and_key`.)
2. **Use:** Every segment is encrypted with the stream's key (implemented; see section 3.1).
3. **Rekey:** planned. The rekey module was removed in PR 302.
4. **Delete:** planned. The key would be removed so the segments become unrecoverable, and an audit marker would remain.

An expiry mode built on this (a reaper that deletes keys) is planned; no reaper exists.

---

## 7. Backup and Recovery

### 7.1 What to Back Up

The full `data/wabi-server/` directory is the backup unit (`storage-manifest.json` is inside it, at `wabidb/storage-manifest.json`). A copy of a fixture's data and uploads directories opens as a server with the same engine position, owner, message history and upload registry (test: `core/crates/wabi-server/tests/instance_checkpoint_contract.rs::coordinated_fixture_copy_preserves_matching_database_sidecars_uploads_and_unknown_files`). No test follows the written procedure itself; the list below is the layout described in `STORAGE_FORMAT.md` §1, whose tests are cited there, plus the procedure in `docs/deployment/BACKUP_AND_RECOVERY.md`. Specifically:

- `streams/` — all segments
- `global/commit-index/` — the index, and `global/quarantine.json` if it exists (without it, startup can refuse the quarantined commit again whenever replay covers that commit, for example when no checkpoint covers it; test: `engine::quarantine_tests::failing_handler_is_named_at_startup_and_quarantine_skips_it` refuses with the file absent because replay reaches the bad commit, then starts once the file lists it. Once a checkpoint covers the commit, startup reads it but does not apply its handlers again, so a handler failure does not recur; read `Applier::complete_commit` in `engine/replay.rs`, no test covers it)
- `storage-manifest.json` — the manifest
- `projections/snapshot.json` — the projection checkpoint
- `projections/read-model.sqlite3` — the messages projection. It is derived, so a backup without it restores correctly as long as the log in the same backup is whole: the engine rebuilds it at the first start (test: `tests::read_model_messages::deleting_the_read_model_file_changes_no_read`). Do not remove it from a directory whose log may be incomplete (test: `tests::read_model_messages::a_log_shorter_than_the_checkpoint_is_never_rebuilt_from`)
- `blobs/` — where `wabidb::blobs` would write. Nothing writes it today; uploads live outside this directory (`docs/architecture/INSTANCE_RECOVERY_INVENTORY.md`)
- The root key: unless `WABIDB_ROOT_KEY` is set, the server generates it into `wabidb/root_key` inside the data directory (tests: `core/crates/wabi-server/src/secrets.rs::tests::root_key_generates_persists_and_reuses`, `core/crates/wabi-server/src/secrets.rs::tests::root_key_env_wins_over_file`). That the server passes the `wabidb/` directory is read from `AppState::new` in `state.rs` and `WdbAdapter::resolved_config`. If `WABIDB_ROOT_KEY` is set, the key is not in the data directory and must be backed up separately (`docs/deployment/BACKUP_AND_RECOVERY.md`). The engine itself never persists the key (`wabidb::crypto::bootstrap`)

The full recovery unit, including sidecar files and uploads, is in `docs/architecture/INSTANCE_RECOVERY_INVENTORY.md`.

### 7.2 Backup Workflow

There is no `wabidb backup` command. It was removed in PR 302. A backup today is a copy of the whole data directory taken while the server is stopped; the steps are in `docs/deployment/BACKUP_AND_RECOVERY.md`. Quiescing a running engine, freezing a manifest hash and verifying it after the copy are *planned*.

Helpers that copy and hash files exist (`retention::manifest_backup`, `retention::data_backup`, `retention::verify_backup`; tests: `retention::manifest_backup::tests::backup_to_new_dir`, `retention::data_backup::tests::backup_populated`, `retention::verify_backup::tests::hash_mismatch_reported`) but no command or server route runs them.

### 7.3 Restore

Restore is the inverse: write the directory back with the server stopped. `wabidb-cli check` and `wabidb-cli verify` can then be run against the restored directory. `check` scans the segments the commit index references and reports `ok: false` when none are found or a record is missing or damaged; `verify` reads the manifest and checks the segments (tests: `cli::check::tests::check_scans_the_segments_a_real_engine_wrote`, `cli::check::tests::zero_segments_with_indexed_commits_is_not_ok`, `cli::check::tests::missing_indexed_record_is_not_ok`, `cli::verify::tests::real_engine_tree_verifies`, `cli::verify::tests::corrupted_segment_in_encoded_stream_dir_returns_error`). The engine does not compare a manifest hash at startup; a "refuse to start when the manifest hash disagrees" setting is *planned*.

---

## 8. What This Document Does Not Cover

- Wire protocol for client-server sync — see `docs/architecture/ARCHITECTURE.md` §5
- Internal Wabidb key derivation — see `wabidb::crypto::bootstrap`
- Operator runbook for backups and recovery — see `docs/deployment/BACKUP_AND_RECOVERY.md`

---

## 9. Cross-References

- `docs/architecture/STORAGE_FORMAT.md` — full byte-level format spec
- `docs/proposals/wabidb-endstate.md` — Wabidb endstate design (the larger storage architecture)
- `docs/deployment/BACKUP_AND_RECOVERY.md` — operator backup and recovery runbook
- `docs/architecture/ARCHITECTURE.md` §4 — Wabidb engine architecture
- `docs-history branch (archive/) 2026-04-stdb-migration/` — historical context for what this doc replaced