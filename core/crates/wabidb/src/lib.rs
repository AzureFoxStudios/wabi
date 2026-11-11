//! WabiDB — per-stream log-structured event store with a global commit index.
//!
//! WabiDB is the storage engine embedded in `wabi-server`. Each statement below
//! names the test that shows it; a statement marked *planned* is not implemented.
//! The on-disk layout and a test for each format rule are in
//! `docs/architecture/STORAGE_FORMAT.md`.
//!
//! Opening an engine creates its lock file, storage manifest and commit-index directory
//! (test: `tests::integration::engine_starts_and_serves_a_command` asserts those three
//! exist; the command it then sends goes through a sequencer the test builds by hand, not
//! through the engine). The engine accepts a command through `run_command` and projects
//! it (test: `engine::tests::room_placement_event_is_projected_and_restored_after_restart`).
//! One process owns a data directory at a time (test:
//! `tests::integration::two_engines_cannot_share_a_data_dir`).
//!
//! ## Architecture overview
//!
//! - **Per-stream segments** (`stream_log`): append-only `.wseg` files in one directory
//!   per stream, rotating at about 64 MiB. Event records are AES-256-GCM encrypted with
//!   the stream's key (tests: `stream_log::segment_writer::tests::segment_rotation_on_full`
//!   fills one segment and reopens the next by hand; the sequencer's own rotation check
//!   has no test; `crypto::aes_gcm_record::tests::encrypt_decrypt_round_trip`). Each record carries a
//!   `commit_seq`.
//! - **Global commit index** (`commit_index`): the canonical ordering of all commits, one
//!   entry per commit (test: `engine::replay::tests::replay_applies_events_in_global_commit_seq_order`).
//!   Startup tolerates a zero-filled or partial final entry and refuses any other damage
//!   (tests: `commit_index::batcher::tests::zero_filled_tail_keeps_entries_and_engine_opens`,
//!   `commit_index::batcher::tests::corrupt_middle_entry_in_sealed_file_refuses_to_open`).
//! - **Commit sequencer** (`sequencer`): a single async task holding the sole
//!   `Semaphore(1)` permit (see `engine::locks`; test: `sequencer::tests::no_two_sequencers`).
//!   It assigns monotonic `commit_seq`, writes the per-stream segments, appends to the
//!   commit index and fsyncs; one fsync can cover several commits (test:
//!   `sequencer::tests::group_commit_shares_fsyncs_under_concurrency`). The caller is
//!   answered after projection application (test:
//!   `sequencer::tests::completion_waits_for_projection_application`).
//! - **Projections** (`projections`): in-memory read model of the commit log. Indexes are
//!   `crossbeam-skiplist::SkipMap`s behind an outer `RwLock`; writes take the write lock
//!   (no test shows which lock a path takes; read `engine::locks` `ProjectionState::insert`
//!   and `get`). On start the engine loads `projections/snapshot.json` when one
//!   exists and replays the log from the commit index. A restart with the snapshot present,
//!   and one with it deleted so the whole log is replayed, both leave a removed reaction
//!   removed (test:
//!   `engine::message_admission_tests::removed_reaction_stays_removed_after_reopen_and_replay`).
//!   No test checks that replay skips the commits a snapshot already covers; that is read
//!   from `engine/mod.rs` (`open`) and `engine/replay.rs` (`replay_projections`). A snapshot
//!   never claims more than its rows hold (test:
//!   `engine::locks::tests::snapshot_never_overclaims_watermark_coverage`). A persistent
//!   read model is *planned* (`docs/architecture/ADR-0001-projection-storage.md`).
//! - **Retention** (`retention`): backup helpers that copy and hash files (tests:
//!   `retention::data_backup::tests::backup_populated`,
//!   `retention::verify_backup::tests::hash_mismatch_reported`). No command or server
//!   route runs them. There is no retention engine, reaper, key destruction or compaction;
//!   those are *planned*.
//! - **Blob store** (`blobs`): BLAKE3 content-addressed files written by temp file, fsync
//!   and rename, with a range read (a written blob exists and reads back: test
//!   `blobs::write::tests::write_creates_canonical_file`; the range read: test
//!   `blobs::range_read::tests::range_read_partial`; no test covers the temp-file, fsync
//!   and rename order, which is read from `blobs/write.rs::BlobWriter::write`). Nothing in the engine or the server
//!   calls it; uploads are stored by wabi-server, outside this crate.
//! - **Storage CLI** (`cli`): `wabidb-cli` commands `check`, `verify`, `status` and
//!   `list-streams` only read and never take the lock (test:
//!   `cli::tests::commands_are_read_only_and_never_touch_the_lock`). `quarantine` is the
//!   one command that writes: it records a commit for replay to skip in
//!   `global/quarantine.json` while holding the lock (tests:
//!   `cli::quarantine::tests::quarantine_fails_while_the_lock_is_held`,
//!   `engine::quarantine_tests::failing_handler_is_named_at_startup_and_quarantine_skips_it`).
//!
//! ## Design references
//!
//! - Endstate doc: `docs/proposals/wabidb-endstate.md`
//! - Council reviews: `docs/architecture/wabidb-council-reviews.md`
//! - Kanban: `docs/wabidb-kanban.md`

#![allow(clippy::needless_return)]

// Top-level modules. Each is filled in by its own kanban card.
pub mod blobs;
pub mod cli;
pub mod commands;
pub mod commit_index;
pub mod crypto;
pub mod engine;
pub mod error;
pub mod format;
pub mod fuzz;
pub mod maintenance;
pub mod projections;
pub mod replication;
pub mod retention;
pub mod sequencer;
pub mod snapshots;
pub mod storage;
pub mod stream_identity;
pub mod stream_log;
#[cfg(test)]
pub mod tests;
pub mod domain;
