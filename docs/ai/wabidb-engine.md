# WabiDB Engine — Core Architecture

WabiDB is an encrypted, event-sourced database embedded in `wabi-server`. It is NOT a key-value store, SQL database, or generic KV engine. Clients submit structured `CommandCommit` messages containing typed events.

## Commit flow

All writes flow through one sequencer:

```
CommandCommit
  → 1. Sequencer (Semaphore(1)) — assign monotonic commit_seq (burned on failure)
  → 2. Segment writes — encrypt (AES-256-GCM) and append to per-stream .wseg files
  → 3. Commit index — build CommitIndexEntry with all StreamRefs, submit to batcher
  → 4. Durability-await — batcher group-flushes, caller waits for fsync
  → 5. Barrier advance — linearizability barrier makes commit visible to readers
  → 6. Projection dispatch — spawn_projection_dispatcher() updates materialized views
  → 7. Response — outcome (including commit_seq) returned via oneshot channel
```

Tests for the steps: single writer (`sequencer::tests::no_two_sequencers`, `engine::locks::tests::sequencer_permit_serializes_writers`); a failed command burns its commit_seq and the number is not reused (`sequencer::tests::burned_seq_on_failure`, `tests::power_loss::restart_never_reuses_commit_seq`); one fsync can cover several concurrent commits (`sequencer::tests::group_commit_shares_fsyncs_under_concurrency`); the caller waits for durability and for projection application (`sequencer::tests::durability_await`, `sequencer::tests::completion_waits_for_projection_application`); the dispatcher applies commits in order (`engine::locks::tests::dispatcher_processes_items_in_order`); a failed projection application is durable but stops later commits and refuses to report ready on restart (`sequencer::tests::failed_application_stops_a_durable_group_without_dispatching_later_commands`, `tests::write_completion::projection_failure_is_durable_but_never_successful_or_ready_on_restart`).

## Storage

| File | Purpose |
|------|---------|
| `.wseg` | Append-only segment files, max ~64 MiB each. Records: 48-byte header + payload + zero padding to a 16-byte boundary. Magic `b"WABI"`, CRC32C on the header; the payload CRC is `0` (unchecked) for encrypted records. (tests: `format::record::tests::round_trip_event`, `format::record::tests::total_size_includes_alignment_padding`, `stream_log::segment_writer::tests::segment_rotation_on_full`, which reopens the next segment by hand; the sequencer's own rotation check has no test) |
| `.widx` | Global commit index, batcher with configurable batch size/age. Maps events to segment locations. Magic `b"WIDX"`. (tests: `commit_index::batcher::tests::batch_size_triggers_flush`, `commit_index::batcher::tests::max_age_triggers_flush`, `commit_index::batcher::tests::file_rotation_at_10000_entries`) |
| `.wsnap` | Planned / unused. A writer exists (`snapshots::writer`, test: `snapshots::writer::tests::write_and_read_back`) but nothing calls it. The engine's checkpoint is `projections/snapshot.json`. |
| `.bin` + `.meta` | BLAKE3-addressed large binary data. `.meta` is a three-line text file (`blake3=`, `size=`, `created_at_micros=`), not a binary `BMTA` file. (test: `blobs::write::tests::metadata_sidecar_written` checks the three keys are present; the `blobs/<hash[0..2]>/<rest>.bin` path layout has no test, see `STORAGE_FORMAT.md` §5.1) Nothing in the engine or the server calls `wabidb::blobs`, so a real data directory has no `blobs/`. |
| `storage-manifest.json` | `schema_version`, `format_version`, `engine_version`, `created_at_micros`, `highest_commit_seq`. No per-stream metadata. (test: `engine::tests::open_creates_storage_manifest` asserts the file exists with `schema_version` 1 and `engine_version` "0.1.0"; an engine-written manifest deserializes into those five fields (test: `cli::verify::tests::real_engine_tree_verifies`); the `highest_commit_seq` update has no test) |
| `global/quarantine.json` | Commits the operator told replay to skip. Written only by `wabidb-cli quarantine`. (tests: `engine::quarantine_tests::failing_handler_is_named_at_startup_and_quarantine_skips_it`, `cli::quarantine::tests::quarantine_appends_once_and_refuses_unindexed_seqs`) |

## Security

- **AES-256-GCM**: event payloads encrypted with `commit_seq` as nonce and the 48-byte record header as AAD (tests: `crypto::aes_gcm_record::tests::encrypt_decrypt_round_trip`, `crypto::aes_gcm_record::tests::nonce_construction`, `crypto::aes_gcm_record::tests::bit_flip_in_aad_fails_auth`, `crypto::aes_gcm_record::tests::wrong_key_fails_auth`; the bit-flip test flips byte 10, so the tests show the header is bound as AAD, not that all 48 bytes are)
- **Per-stream keys**: each stream's key is derived from the bootstrap key and the stream id, and replay of a legacy raw-named stream directory derives it from the raw id (tests: `engine::stream_dir_tests::legacy_raw_colon_directory_replays_with_raw_id_and_key`, `engine::stream_dir_tests::encoded_directory_registers_decoded_key_when_snapshot_covers_records`)
- **Key exchange (X3DH / double ratchet)**: removed in PR 302. WabiDB has no key-exchange code.
- **Key destruction**: not implemented (design intent only). Timed retention is a soft delete and nothing is cryptographically destroyed.

## Projections

In-memory materialized views backed by `crossbeam-skiplist::SkipMap` indexes, rebuilt on restart from the saved `projections/snapshot.json` when there is one and from the commit index (tests: `engine::message_admission_tests::removed_reaction_stays_removed_after_reopen_and_replay` restarts once with the checkpoint present and once with it deleted and gets the same state; `engine::locks::tests::snapshot_never_overclaims_watermark_coverage` shows a saved checkpoint never claims more than its rows hold; `engine::replay::tests::replay_applies_events_in_global_commit_seq_order` shows replay order). No test shows that replay skips the commits a checkpoint already covers. Replay holds a bounded number of decoded events (test: `engine::replay::tests::replay_holds_decoded_events_bounded_by_stream_count`). A projection handler that fails or panics on a commit stops startup with an error naming the commit (tests: `engine::quarantine_tests::failing_handler_is_named_at_startup_and_quarantine_skips_it`, `engine::quarantine_tests::panicking_handler_is_named_at_startup_and_quarantine_skips_it`).

### Messages: the SQLite read model

Messages are the first projection kept in SQLite instead (ADR-0001): `projections/read-model.sqlite3`, with the latest row of each message in `messages` and one row per message event in `message_versions` (`projections/read_model/schema.rs`). What holds for that file:

- **Derived.** It is built from the log. Deleting it from a stopped engine changes no read (test: `tests::read_model_messages::deleting_the_read_model_file_changes_no_read`). Compaction is not an event, so a rebuild brings compacted rows back (same test).
- **Not encrypted, mode 0600.** It holds message bodies as the snapshot did; SQLite's `-wal` and `-shm` side files get the same mode (tests: `tests::read_model_messages::the_read_model_file_is_owner_only_and_messages_leave_the_snapshot`, `projections::read_model::tests::the_file_and_its_write_ahead_log_are_created_owner_only`).
- **One transaction per commit.** A commit's rows and its `applied_commit_seq` are committed together, so a reader sees a commit whole or not at all, and a commit whose handler fails keeps none of its rows (tests: `tests::read_model_messages::concurrent_readers_never_see_part_of_a_commit`, `tests::read_model_messages::a_commit_that_fails_to_apply_stores_none_of_its_messages`).
- **Generation.** The file records a schema version and a read-model generation (`READ_MODEL_GENERATION`). A file from another generation is replaced and rebuilt from the log (test: `tests::read_model_messages::a_read_model_of_another_generation_is_rebuilt_from_the_log`). Whoever changes a record version or what a handler stores must bump the generation; a pinned hash of the stored rows fails until they do (test: `projections::messages::tests::stored_rows_are_pinned_to_the_read_model_generation`).
- **Two watermarks.** A checkpoint first makes the read model durable at the watermark, then writes `snapshot.json`. At startup a read model ahead of the snapshot is kept and replay skips the message events it holds; one that is missing, unusable or behind the snapshot is rebuilt, with every other projection, from the whole log (tests: `tests::read_model_messages::a_read_model_ahead_of_the_snapshot_is_kept_and_replay_skips_its_events`, `tests::read_model_messages::a_read_model_behind_the_snapshot_is_rebuilt_with_every_projection`, `tests::power_loss::crash_between_read_model_sync_and_snapshot`).
- **Startup replay is one transaction.** If replay fails, the file holds nothing replay wrote (test: `tests::read_model_messages::a_failed_startup_replay_leaves_none_of_its_messages_in_the_file`).
- **Never rebuilt from a short log.** If the commit index ends below the snapshot's watermark or the read model's, the log has lost commits. The engine then starts only if the read model is usable and at exactly the snapshot's watermark; otherwise it refuses with "repair required" and changes nothing (tests: `tests::read_model_messages::a_checkpoint_that_outlived_its_log_opens_when_both_stores_agree`, `tests::read_model_messages::a_log_shorter_than_the_checkpoint_is_never_rebuilt_from`). The sequencer always continues above the snapshot's watermark, the read model's and the manifest's recorded height (test: `tests::read_model_messages::the_next_commit_is_above_the_manifests_recorded_height`).
- **Damage.** The file is checked with `PRAGMA quick_check` at every open; a damaged file is replaced and rebuilt when the log is whole, and kept, with startup refused, when it is not (test: `tests::read_model_messages::a_damaged_read_model_is_rebuilt_from_a_whole_log_and_kept_when_the_log_is_short`). Damage SQLite reports while running makes the engine unhealthy and leaves `projections/read-model.rebuild`, which makes the next start rebuild (test: `tests::read_model_messages::damage_at_run_time_makes_the_engine_unhealthy_and_the_next_start_rebuilds`).
- **Quarantine.** `wabidb-cli quarantine` leaves the same rebuild request, so a commit the read model had applied is gone after the next start (test: `tests::read_model_messages::quarantining_a_commit_the_read_model_holds_removes_it_from_the_read_model`).
- **Old snapshots.** A snapshot saved before this change still lists five message indexes. They are not loaded (tests: `projections::message_lookup::tests::legacy_snapshot_message_indexes_are_not_loaded`, `tests::pre_versioning_fixture::opening_rebuilds_messages_from_the_log_not_the_snapshot`).
- **Offline inspection** compares every row and column of the read model with a full replay when the directory holds a read model the engine would use as it is, after a full SQLite integrity check. It reports `readModelPresent`, `readModelCompared` and the reason when it did not compare (no file, or a file the engine would replace or rebuild). It refuses a file the engine would serve but that cannot be verified: a write-ahead log that still holds frames, a failed integrity check, or more commits than the checkpoint (test: `engine::offline_inspect::tests::read_model_rows_are_compared_and_a_changed_message_is_refused`).

Not measured or proven: behaviour under real power loss (the tests end the process, the operating system keeps its buffers), and Windows.

## WabiStore trait

`src/engine/wabi_store.rs` — the typed domain API (50+ methods). Two implementations:
- **`WdbAdapter`** (wabi-server) — real engine, writes events via `self.run()` (test: `core/crates/wabi-server/tests/message_delivery_contract.rs::committed_text_is_accepted_but_failed_text_and_file_writes_have_no_success_effects`)
- **`LocalWabiStore`** (wabidb) — HashMap-backed in-memory store for testing

## Testing

| Layer | Coverage |
|-------|----------|
| Unit | Run `cargo test -p wabidb` for the current count; it is not recorded here because it goes stale. |
| Property | Proptest round-trips (`tests::property_tests::record_encode_decode_round_trip`, `tests::property_tests::commit_index_encode_decode_round_trip`, `tests::property_tests::message_record_postcard_round_trip`) |
| Integration | `tests::integration::engine_starts_and_serves_a_command`, `tests::send_message_flow::send_message_flow` |
| Decoder robustness | Fixed inputs only, not a fuzz target: `fuzz::tests::garbage_input_does_not_panic`, `fuzz::tests::stream_ref_garbage_does_not_panic`, `fuzz::tests::commit_index_entry_garbage_does_not_panic`, `fuzz::tests::composite_key_garbage_does_not_panic` |
| Process-exit crash | `tests::power_loss`: three in-process tests (`simulate_power_loss_before_fsync`, `simulate_crash_between_segment_write_and_commit_index`, `simulate_power_loss_after_commit_index_fsync`), `restart_never_reuses_commit_seq`, and five subprocess tests marked `#[ignore]` behind the `test-harness` feature (`crash_before_any_write`, `crash_mid_stream_write`, `crash_before_index_fsync`, `crash_after_index_fsync`, `crash_after_projection_update`). The CI job `power-loss` runs the ignored ones. They end the process; no test discards the operating system's page cache, so fsync ordering is not proven by a test. |

## Benchmarks

`benches/projection_read.rs` and `benches/commit_throughput.rs` exist. Numbers from them are not recorded here; run `cargo bench -p wabidb` to measure.

## Key pitfalls

- **Not a KV store** — no `get(key)`/`put(key, value)`. The API is command/event-based.
- **No SQL** — no MVCC, bloom filters, or WAL.
- **Single-threaded sequencer** — write throughput bounded by single-core commit processing.
- **Projections are in-memory** — large datasets may have slow recovery (planned: a derived on-disk read model, `docs/architecture/ADR-0001-projection-storage.md`).
- **Commit-index files resume after a restart** — the batcher continues numbering after the highest existing `.widx` file (test: `commit_index::batcher::tests::partial_final_entry_survives_a_second_restart_after_new_commits`).