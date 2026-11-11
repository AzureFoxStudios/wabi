# WabiDB Storage Format

On-disk layout for the WabiDB event-sourced database.

## Data directory

```
$DATA_DIR/                      (the engine directory, e.g. data/wabi-server/wabidb)
├── .lock                       (advisory lock; never unlink it, see AGENTS.md rule 9)
├── storage-manifest.json
├── global/commit-index/
│   └── *.widx
├── global/quarantine.json      (only after `wabidb-cli quarantine`; see below)
├── streams/<kind>/<stream_dir>/events/
│   ├── 00000001.wseg
│   └── 00000002.wseg
├── projections/snapshot.json
└── blobs/
```

`<kind>` is `channel`, `dm`, `whiteboard`, `place`, `kanban` or `other`. Segment files are zero-padded 8-digit numbers (test: `cli::check::tests::check_scans_the_segments_a_real_engine_wrote` builds a tree with the real engine and walks this layout; `stream_log::segment_writer::tests::next_segment_id_increments`).

`global/quarantine.json` has the form `{"version":1,"commit_seqs":[...]}`. Replay skips each listed commit; startup refuses a file it cannot parse or that lists a commit above every commit on disk (tests: `engine::quarantine_tests::failing_handler_is_named_at_startup_and_quarantine_skips_it`, `engine::quarantine_tests::unparseable_quarantine_file_refuses_startup`, `engine::quarantine_tests::quarantine_file_listing_a_future_seq_refuses_startup`). Only `wabidb-cli quarantine` writes it (test: `cli::quarantine::tests::quarantine_appends_once_and_refuses_unindexed_seqs`).

Stream ids are arbitrary safe strings, not only `kind_ULID`: `ch_01JABCDEF...`, `channels`, `community-roster:v1`, `user:42`. `<stream_dir>` is the stream id made safe as a directory name (PR 293, 2026-11-10):

- An id made only of `[A-Za-z0-9._-]`, not ending in `.`, and not a Windows device name (`CON`, `NUL`, `COM1`, ...) is its own directory name (tests: `sequencer::stream_dir_name_tests::portable_ids_keep_their_existing_directory_name`, `sequencer::stream_dir_name_tests::device_names_and_trailing_dots_are_encoded`).
- Any other id is percent-encoded with uppercase hex, so `community-roster:v1` is stored as `community-roster%3Av1`. `%` itself is always encoded, which keeps the mapping one-to-one (tests: `sequencer::stream_dir_name_tests::colon_ids_round_trip_to_windows_safe_names`, `sequencer::stream_dir_name_tests::decoding_is_canonical_so_the_mapping_is_injective`).
- Trees written before PR 293 hold the raw id as the directory name, colon included. Those directories are never renamed. A stream that has a raw-named directory keeps writing to it, and replay accepts both spellings, choosing the id whose hash matches each record header (tests: `engine::stream_dir_tests::legacy_raw_colon_directory_replays_with_raw_id_and_key`, `engine::stream_dir_tests::append_to_legacy_raw_directory_never_splits_the_stream`, `engine::stream_dir_tests::fresh_tree_writes_encoded_directory_and_replays_it`).

The one encode/decode pair is `stream_dir_name` / `stream_id_from_dir_name` in `core/crates/wabidb/src/sequencer/mod.rs`; build stream paths with `resolve_stream_dir`, never by joining the id. Upgrade and restore consequences are in `docs/deployment/BACKUP_AND_RECOVERY.md`, Version compatibility.

## Stream segment format (.wseg)

Append-only, max ~64 MiB each (test: `stream_log::segment_writer::tests::segment_rotation_on_full`). Each record:

```
48-byte RecordHeader + variable payload + zero padding up to the next 16-byte boundary
```

(tests: `format::record::tests::total_size_includes_alignment_padding`, `stream_log::segment_writer::tests::padding_correctness`)

Header fields:
- Magic: `b"WABI"` (0x57 0x41 0x42 0x49)
- Format version: u16 (currently 1)
- Header length: u16 (48 bytes)
- Record kind: u16 (1=event, 2=snapshot, 3=tombstone, 4=checkpoint)
- Flags: u16 (must be 0)
- Commit sequence: u64 (monotonic per stream)
- Stream ID hash: [u8; 16] (first 16 bytes of BLAKE3(stream_id))
- Payload length: u32 (max 16 MiB)
- Header CRC32C: covers bytes 0-39
- Payload CRC32C: covers the payload; `0` means "not checked" (encrypted records rely on the GCM tag instead)

(test: `format::record::tests::round_trip_event`, `format::record::tests::header_crc_mismatch_rejected`, `format::record::tests::payload_crc_verification`, `stream_log::segment_reader::tests::non_zero_payload_crc_verified_by_reader`)

Record kinds: the header decoder accepts 1=event, 2=snapshot, 3=tombstone, 4=checkpoint (test: `format::record::tests::round_trip_all_kinds`). Kinds 2 to 4 are reserved and planned; this document specifies no behavior for a snapshot, tombstone or checkpoint record.

Event payload: AES-256-GCM, 12-byte nonce from `commit_seq`, header bytes as AAD, tag appended (tests: `crypto::aes_gcm_record::tests::encrypt_decrypt_round_trip`, `crypto::aes_gcm_record::tests::nonce_construction`, `crypto::aes_gcm_record::tests::bit_flip_in_aad_fails_auth`).

Reading a segment: the reader stops at the first invalid header, truncated tail or non-zero padding, and skips a record whose payload CRC fails (tests: `stream_log::segment_reader::tests::truncated_tail_returns_valid_prefix`, `stream_log::segment_reader::tests::corrupted_middle_record_is_skipped`). Valid records that the commit index does not reference are orphans and are skipped (tests: `stream_log::segment_reader::tests::orphan_records_skipped_when_filter_rejects`, `sequencer::tests::orphan_records_tolerated`). The engine does not physically truncate a segment at startup. A helper that does (`stream_log::recovery::scan_segment_file`, test: `stream_log::recovery::tests::recovery_truncates_at_corrupt_record`) is not part of engine startup.

## Commit index format (.widx)

Global ordering log. File header (16 bytes):
- Magic: `b"WIDX"` (0x57 0x49 0x44 0x58)
- Format version: u16 (1)
- Flags: u16 (0x0000 = current/appending, 0x0001 = sealed)
- Entry count: u32 (max 10,000)
- Header CRC32C: bytes 0-11

(An unsealed file's header carries entry count 0; the count is filled in when the file is sealed.)

Entry structure (variable length):
- Entry length: u32
- Commit sequence: u64 (monotonic, never reused)
- Timestamp: i64 (microseconds)
- Caller user ID: u64 (0 = system)
- Caller device ID hash: [u8; 16]
- Command name hash: [u8; 16]
- Has idempotency key: u8
- Idempotency key hash: [u8; 32] (if present)
- Event reference count: u32
- Event references: StreamRef[] array
- Payload hash count: u32, then that many 32-byte payload hashes
- Entry CRC32C

(tests: `commit_index::record::tests::round_trip_all_fields`, `commit_index::record::tests::byte_identical_round_trip`, `commit_index::record::tests::bad_crc_rejected`)

StreamRef (33 bytes): stream ID hash (16), stream kind (1), segment ID (8), offset (4), length (4) (test: `commit_index::record::tests::stream_ref_round_trip`).

File trailer (32 bytes): highest commit sequence, file CRC32C, reserved. Written when a file is sealed, after 10,000 entries or at clean shutdown (tests: `commit_index::batcher::tests::file_rotation_at_10000_entries`, `commit_index::batcher::tests::graceful_shutdown_flushes_remaining`).

Reading the index at startup:
- A tail of all zero bytes, or a partial final entry in a file that was never sealed, is tolerated: the entries before it are used and the offset is logged (tests: `commit_index::batcher::tests::zero_filled_tail_keeps_entries_and_engine_opens`, `commit_index::batcher::tests::partial_final_entry_in_unsealed_file_keeps_prior_entries_and_engine_opens`, `commit_index::batcher::tests::partial_final_entry_survives_a_second_restart_after_new_commits`).
- Anything else (a bad CRC or damaged entry with valid bytes after it, or damage inside a sealed file) refuses startup with an error naming the file and offset; the file is not repaired or truncated (tests: `commit_index::batcher::tests::corrupt_middle_entry_in_sealed_file_refuses_to_open`, `commit_index::batcher::tests::bad_crc_in_current_file_refuses_to_open`).
- A new `.widx` file is followed by a directory fsync (test: `commit_index::batcher::tests::new_widx_file_fsyncs_its_directory_on_creation`).

## Snapshot format (.wsnap)

Planned / unused. `snapshots::writer::SnapshotWriter` can write a `{seq:08}.wsnap` file (magic `b"WSNAP"`, version u8, flags u16, commit_seq u64, 32-byte projection state hash, commit_seq again, CRC32C), and a test-only helper reads it back (tests: `snapshots::writer::tests::write_and_read_back`, `snapshots::writer::tests::crc_mismatch_detected`), but nothing in the server or engine calls it, and the file carries a hash, not projection state. The checkpoint the engine actually uses is `projections/snapshot.json` (test: `engine::locks::tests::snapshot_never_overclaims_watermark_coverage`). Earlier text here described a `b"WSNP"` layout with BSATN state; no code writes that.

## Blob storage

Unused: nothing in the engine or the server calls `wabidb::blobs`, the engine never creates `blobs/`, and wabi-server keeps uploads in its own registry. What the tested writer produces is a two-file system:
- `.bin` — raw blob data at `blobs/<hash[0..2]>/<rest>.bin` (test: `blobs::write::tests::canonical_path_layout`)
- `.meta` — a text sidecar, `blake3=<hex>`, `size=<bytes>`, `created_at_micros=<n>`, one per line (test: `blobs::write::tests::metadata_sidecar_written`). Earlier text described a binary `b"BMTA"` file; the writer does not produce one.

## Storage manifest (JSON)

`$DATA_DIR/storage-manifest.json` (test: `engine::tests::open_creates_storage_manifest`). The engine writes only these fields; `highest_commit_seq` is refreshed at open:

```json
{
  "schema_version": 1,
  "format_version": 1,
  "engine_version": "0.1.0",
  "created_at_micros": 1718901234567890,
  "highest_commit_seq": 12345
}
```

`wabidb-cli verify` reads exactly this shape (test: `cli::verify::tests::real_engine_tree_verifies`). A per-stream list and a `config` block are planned, not written.

## Versioning

- Record headers carry a `format_version` of 1; the decoder rejects any other value with an error, not a panic (test: `format::record::tests::unsupported_version_rejected`). Checking a commit-index file's magic, version, header CRC and trailer CRC when reading it is planned; startup relies on each entry's own CRC (tests under "Reading the index at startup" above).
- No migration path between format versions exists yet; a version bump is a planned design task.