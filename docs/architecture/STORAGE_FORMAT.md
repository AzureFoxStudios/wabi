# WabiDB Storage Format Specification

> **Card:** wabidb-02 (Phase 1, Storage Format)
> **Status:** v1 specification
> **Source of truth:** the code and its tests. `docs/proposals/wabidb-endstate.md` §11.1–11.5 is the original design and is a proposal, not a description of what runs.
> **Date:** 2026-06-20; truth pass 2026-11-11 (Task 2.3)
> **How to read this file:** each statement about what the engine does ends with the test that proves it, in the form `(test: path::name)`. A section or sentence marked *planned* is not implemented. Anything the code does that is not in the file is not specified here.

This document is the authoritative byte-level specification of the WabiDB on-disk format. It is the contract that the writer code (`wabidb::stream_log::segment_writer`) and the reader code (`wabidb::stream_log::segment_reader`) must agree on. The `wabidb-04` implementation card (Custom byte primitives) implements the read/write helpers for these structures.

All multi-byte integers are **little-endian**. All CRCs are **CRC32C** (Castagnoli polynomial, `0x1EDC6F41`).

## 1. Data directory layout

```
$DATA_DIR/
├── .lock                           # advisory lock inode; never unlink it
├── storage-manifest.json
├── streams/
│   └── <kind>/                     # channel, dm, whiteboard, place, kanban, other
│       └── <stream_dir>/           # one directory per stream
│           └── events/
│               ├── 00000001.wseg   # segment files, 64 MiB max each
│               └── ...
├── global/
│   ├── commit-index/
│   │   ├── 00000000.widx           # sealed index files
│   │   └── 00000001.widx           # current (still appending)
│   └── quarantine.json             # only after `wabidb-cli quarantine`
├── projections/
│   ├── snapshot.json               # the engine's projection checkpoint
│   └── read-model.sqlite3          # messages and channels projections (SQLite; -wal and -shm beside it while running)
└── blobs/                          # only if wabidb::blobs is used; nothing calls it (§5)
    └── <hash[0..2]>/
        ├── <rest-of-hash>.bin
        └── <rest-of-hash>.meta
```

(tests: `cli::check::tests::check_scans_the_segments_a_real_engine_wrote` builds a tree with the real engine and walks this layout; `engine::tests::open_creates_storage_manifest` (asserts the manifest exists, not the layout); `engine::tests::open_creates_lock_file`; `engine::tests::open_creates_commit_index_dir`.) Earlier drafts of this file showed per-stream `snapshots/*.wsnap` directories, a `patches/` directory, a `manifests/` directory and per-blob `manifests/`. The engine creates none of them.

Stream IDs are arbitrary safe strings, not only `kind_ULID` (`channels`, `community-roster:v1`, `user:42`). `<stream_dir>` is the stream id made safe as a directory name: ids made of `[A-Za-z0-9._-]` are unchanged, any other id is percent-encoded, and older trees keep their raw-named directories (tests: `sequencer::stream_dir_name_tests::portable_ids_keep_their_existing_directory_name`, `sequencer::stream_dir_name_tests::colon_ids_round_trip_to_windows_safe_names`, `engine::stream_dir_tests::legacy_raw_colon_directory_replays_with_raw_id_and_key`). The full rule is in `docs/ai/wabidb-storage.md`.

Segment file numbering: monotonically increasing `u64` zero-padded to 8 digits, suffix `.wseg`; the next number is one past the highest existing file (test: `stream_log::segment_writer::tests::next_segment_id_increments`, which creates files named `00000003.wseg`, `00000010.wseg` and checks the next ids; the first segment a writer creates is named `00000001.wseg`, asserted by `stream_log::segment_writer::tests::flush_and_close_persist_data`). A new segment is created when the current one is full (test: `stream_log::segment_writer::tests::segment_rotation_on_full`; the test writes until `is_full()`, checks the file is within two records of 64 MiB and opens the next segment by hand; the sequencer's own rotation check (`writer.is_full()` in `sequencer/mod.rs`) has no test). Rotating a stream for any other reason is planned, not implemented.

## 2. Stream segment file format (`.wseg`)

A stream segment file is a sequence of records. Each record has a 48-byte header, a variable-length payload, and 16-byte alignment padding.

### 2.1 Record header (48 bytes)

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 4 | `magic` | `[u8; 4]` | Always `b"WABI"` (`0x57 0x41 0x42 0x49`) |
| 4 | 2 | `format_version` | `u16` | Current: `1` |
| 6 | 2 | `header_len` | `u16` | Current: `48` (allows future expansion) |
| 8 | 2 | `record_kind` | `u16` | 1=event, 2=snapshot, 3=tombstone, 4=checkpoint |
| 10 | 2 | `flags` | `u16` | Reserved, must be `0` |
| 12 | 8 | `commit_seq` | `u64` | Monotonic per stream; matches the global commit index entry |
| 20 | 16 | `stream_id_hash` | `[u8; 16]` | First 16 bytes of `BLAKE3(stream_id)` |
| 36 | 4 | `payload_len` | `u32` | Length of payload in bytes; max `16 MiB` (`0x0100_0000`) |
| 40 | 4 | `header_crc32c` | `u32` | CRC32C of header bytes `[0..40)` (i.e., the header up to but not including this field and the payload CRC) |
| 44 | 4 | `payload_crc32c` | `u32` | CRC32C of the payload bytes that follow the 48-byte header; `0` means "not checked" |

**Total header size: 48 bytes** (not 36 — the 36 figure in the endstate doc predates the `payload_crc32c` field) (test: `format::record::tests::round_trip_event`).

Decoding rejects a header in which a bit of `commit_seq` (byte 12) was flipped (test: `format::record::tests::header_crc_mismatch_rejected`); that the checksum covers exactly bytes 0-39 is read from `RecordHeader::encode`/`decode` in `format/record.rs`, and no test flips a byte at the boundary (39 or 40). `verify_payload_crc` rejects a wrong payload and a wrong length (test: `format::record::tests::payload_crc_verification`), and the segment reader skips a record whose payload CRC fails (test: `stream_log::segment_reader::tests::corrupted_middle_record_is_skipped`). `stream_log::segment_reader::tests::non_zero_payload_crc_verified_by_reader` only reads back one record whose CRC is correct, so it is not cited for detection. That encrypted records write `0` here and rely on the GCM tag is read from `sequencer/mod.rs` (`RecordHeader::new(..., 0)`); no test covers the write side. With a `0` there the reader still returns a record whose payload was altered (test: `cli::check::tests::corrupt_indexed_record_is_not_ok` flips a payload byte in an engine-written record and still counts five records read); that test shows `wabidb-cli check` catching it through the commit-index payload hash instead.

### 2.2 Payload

Immediately follows the header. Length is `payload_len` bytes (range `[0, 16 MiB]`).

For `record_kind = 1 (event)`: the payload is the encrypted event, AES-256-GCM under the stream's key. The 12-byte nonce is `commit_seq` as little-endian u64 padded to 12 bytes (zeros in the high 4 bytes) (test: `crypto::aes_gcm_record::tests::nonce_construction`). The AAD is the encoded record header passed to the cipher, and a flipped bit in it fails authentication (test: `crypto::aes_gcm_record::tests::bit_flip_in_aad_fails_auth` flips a bit in byte 10, inside the first 40 bytes; the AAD there is a zero-filled 48-byte vector). That the AAD covers all 48 bytes with `payload_crc32c` set to 0, and not only the first 40, is not shown by a test: I read `sequencer/mod.rs` (`RecordHeader::new(..., 0)` then `header.encode()` passed to `encrypt_record`) and `engine/replay.rs` (`decrypt_record(&key, commit_seq, &header_bytes, ...)`). `wrong_commit_seq_fails_auth` shows the nonce is bound to `commit_seq`, not the AAD. The GCM authentication tag (16 bytes) is appended to the payload; the on-disk payload length therefore includes the tag (test: `crypto::aes_gcm_record::tests::encrypt_decrypt_round_trip`). The plaintext is a record encoded by the projection that owns the event; §7.1 describes the version header that 30 record types carry.

For `record_kind` 2 (snapshot), 3 (tombstone) and 4 (checkpoint): the header decoder accepts these values (test: `format::record::tests::round_trip_all_kinds`) but no payload layout or behavior is specified or implemented. Earlier text described a keyed snapshot payload, a tombstone that destroys a stream, and a high-water-mark checkpoint; all three are *planned*. A tombstone record does not destroy any key.

### 2.3 Padding

After the payload, the record is padded with zero bytes to the next 16-byte boundary. The padding is not counted in `payload_len`.

Total record size = `48 (header) + payload_len + padding`, where `padding` is the smallest non-negative integer such that the total is a multiple of 16 (tests: `format::record::tests::total_size_includes_alignment_padding`, `format::record::tests::padding_for_aligns_to_16`, `stream_log::segment_writer::tests::padding_correctness`).

### 2.4 Record validity

The header decoder rejects a record unless all of these hold (tests in `format::record::tests`):
1. The header magic equals `b"WABI"` (`bad_magic_rejected`).
2. The `format_version` is `1` (`unsupported_version_rejected`).
3. The `header_len` equals 48 (`wrong_header_len_rejected`).
4. The `header_crc32c` matches the CRC of bytes 0-39 (`format::record::tests::header_crc_mismatch_rejected` flips one bit of byte 12; no test flips a byte at the 39/40 boundary).
5. The `record_kind` is one of `{1, 2, 3, 4}` (`unknown_record_kind_rejected`).
6. The `payload_len` is in `[0, 16 MiB]` (`oversized_payload_rejected`).
7. The `flags` field is `0` (`non_zero_flags_rejected`).

The payload CRC is checked separately when it is non-zero (`payload_crc_verification`).

The segment reader reads the valid prefix: a file cut at a record boundary yields the records before the cut (test: `stream_log::segment_reader::tests::truncated_tail_returns_valid_prefix`, which cuts exactly where record 4 begins), and it skips a record whose payload CRC fails (test: `stream_log::segment_reader::tests::corrupted_middle_record_is_skipped`). It also stops at a record cut in the middle (tests: `tests::crash_tests::crash_during_segment_write` appends part of a header after one record and still reads that record; `cli::check::tests::missing_indexed_record_is_not_ok` cuts one byte off a segment and reads four of its five records), at an invalid header in the middle of a file, and when the padding after a record is not all zeros; no test covers those last two cases (read `stream_log/segment_reader.rs`: the header decode failure and `UnexpectedEof` branches return `None`, and "Check padding" handles the padding). It never modifies the file.

Truncating a damaged tail is not part of engine startup. A standalone helper, `stream_log::recovery::scan_segment_file`, truncates at the first invalid record (tests: `stream_log::recovery::tests::recovery_truncates_at_corrupt_record`, `stream_log::recovery::tests::recovery_does_not_truncate_clean_file`) but the engine does not call it. Truncate-and-resume at startup is *planned*.

Records that are valid but absent from the global commit index are **orphans**; the reader skips them (tests: `stream_log::segment_reader::tests::orphan_records_skipped_when_filter_rejects`, `sequencer::tests::orphan_records_tolerated`). Replay refuses to start if an indexed event cannot be found (test: `tests::write_completion::missing_indexed_event_refuses_startup_instead_of_restoring_partial_commit`).

## 3. Global commit index file format (`.widx`)

A commit index file is a 16-byte header, a sequence of variable-length entries, and, once the file is sealed, a 32-byte trailer. Files are named `00000000.widx`, `00000001.widx`, ... and are read in that order, starting at `00000000.widx` and stopping at the first missing number (test: `commit_index::batcher::tests::file_rotation_at_10000_entries` writes 10,001 entries into two files and reads entry 10,001 last; `entries_in_order` checks sequence order across 20 entries but writes one file). The stop-at-the-first-gap rule is read from `read_all_entries`; no test covers it.

### 3.1 File header (16 bytes)

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 4 | `magic` | `[u8; 4]` | Always `b"WIDX"` (`0x57 0x49 0x44 0x58`) |
| 4 | 2 | `format_version` | `u16` | Current: `1` |
| 6 | 2 | `flags` | `u16` | `0x0001` = sealed (no more appends), `0x0000` = current (still being appended) |
| 8 | 4 | `entry_count` | `u32` | `0` while the file is being appended; set to the real count (max `10_000`) when sealed |
| 12 | 4 | `header_crc32c` | `u32` | CRC32C of bytes `[0..12)` |

A file is sealed at clean shutdown (test: `commit_index::batcher::tests::corrupt_middle_entry_in_sealed_file_refuses_to_open` shuts a batcher down and asserts the flags field is `0x0001`; `graceful_shutdown_flushes_remaining` shows the remaining 7 entries are readable after shutdown but does not look at the flag). A new file starts after 10,000 entries (test: `commit_index::batcher::tests::file_rotation_at_10000_entries` asserts exactly two files for 10,001 entries). That the rotated file is itself sealed, and that `entry_count` is written on sealing, have no test; they are read from `seal_file` and its callers in `commit_index/batcher.rs`.

### 3.2 Commit index entry (variable length)

A commit index entry is serialized as a length-prefixed flat buffer:

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 4 | `entry_len` | `u32` | Length of the entry body in bytes (excluding this `entry_len` field) |
| 4 | 8 | `commit_seq` | `u64` | Monotonic, never reused (burned `commit_seq` is also never reused, per Council Review #1 §2.4) |
| 12 | 8 | `timestamp_micros` | `i64` | Server time when the commit was assigned |
| 20 | 8 | `caller_user_id` | `u64` | `0` = system caller |
| 28 | 16 | `caller_device_id_hash` | `[u8; 16]` | First 16 bytes of `BLAKE3(device_id)` |
| 44 | 16 | `command_name_hash` | `[u8; 16]` | First 16 bytes of `BLAKE3(command_name)` |
| 60 | 1 | `has_idempotency_key` | `u8` | `0` or `1` |
| 61 | 32 | `idempotency_key_hash` | `[u8; 32]` | present iff `has_idempotency_key == 1`; when absent, the next field starts at offset 61 |
| 93 (or 61) | 4 | `event_ref_count` | `u32` | Number of `StreamRef` entries that follow |
| 97 (or 65) | 33 × N | `event_refs` | `StreamRef[]` | event references |
| ... | 4 | `payload_hash_count` | `u32` | Number of payload hashes that follow |
| ... | 32 × M | `payload_hashes` | `[u8; 32][]` | one hash per event payload; `wabidb-cli check` and `verify` compare records against them |
| ... | 4 | `entry_crc32c` | `u32` | CRC32C of bytes `[4..entry_crc32c)` |

(tests: `commit_index::record::tests::round_trip_all_fields`, `commit_index::record::tests::round_trip_no_idempotency`, `commit_index::record::tests::byte_identical_round_trip`, `commit_index::record::tests::bad_crc_rejected`, `cli::check::tests::corrupt_indexed_record_is_not_ok`)

A burned `commit_seq` is not reused (test: `sequencer::tests::burned_seq_on_failure`, `tests::power_loss::restart_never_reuses_commit_seq`).

### 3.3 StreamRef (33 bytes each)

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 16 | `stream_id_hash` | `[u8; 16]` | First 16 bytes of `BLAKE3(stream_id)` |
| 16 | 1 | `stream_kind` | `u8` | 1=channel, 2=dm, 3=whiteboard, 4=place, 5=kanban, 6=other |
| 17 | 8 | `segment_id` | `u64` | Which `.wseg` file the record lives in |
| 25 | 4 | `offset` | `u32` | Byte offset within the segment (the start of the record header) |
| 29 | 4 | `length` | `u32` | Total record size on disk (header + payload + padding) |

(test: `commit_index::record::tests::stream_ref_round_trip`. The earlier "29 bytes" figure was an arithmetic error: 16 + 1 + 8 + 4 + 4 = 33.)

### 3.4 File trailer (32 bytes)

After the last entry, the file has a 32-byte trailer:

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 8 | `highest_commit_seq` | `u64` | The `commit_seq` of the last entry |
| 8 | 4 | `file_crc32c` | `u32` | CRC32C of all bytes from offset 0 to the start of the trailer (with the sealed header) |
| 12 | 20 | `reserved` | `[u8; 20]` | All zeros; reserved for future fields |

The trailer is written only when a file is sealed. No test reads or checks the trailer bytes (read `seal_file` in `commit_index/batcher.rs`: it appends the highest `commit_seq`, the file CRC32C and zero padding to 32 bytes). Startup does not read it (read `parse_widx_file`, which skips it; no test covers that either).

### 3.5 Validity and startup

The engine reads every `.widx` file in order. For each entry it checks the length and `entry_crc32c`. A new `.widx` file is followed by a directory fsync (test: `commit_index::batcher::tests::new_widx_file_fsyncs_its_directory_on_creation`).

- A tail of all zero bytes, or a partial final entry in a file that was never sealed, is ignored; the entries before it are used and the file name and offset are logged (tests: `commit_index::batcher::tests::zero_filled_tail_keeps_entries_and_engine_opens`, `commit_index::batcher::tests::partial_final_entry_in_unsealed_file_keeps_prior_entries_and_engine_opens`, `commit_index::batcher::tests::truncated_third_entry_keeps_first_two_and_engine_opens`, `commit_index::batcher::tests::partial_final_entry_survives_a_second_restart_after_new_commits`).
- Any other damage (a bad CRC with valid bytes after it, or damage inside a sealed file) refuses startup with an error naming the file and offset (tests: `commit_index::batcher::tests::corrupt_middle_entry_in_sealed_file_refuses_to_open`, `commit_index::batcher::tests::bad_crc_in_current_file_refuses_to_open`).
- The file is never repaired, truncated or re-sealed.

*Planned, not implemented:* checking the file header's magic, version and CRC, `event_ref_count` consistency beyond the entry decoder, and the trailer's `file_crc32c` when reading; truncating a damaged current file and re-sealing it. Earlier text said a corrupt current file "is truncated to the last valid entry and re-sealed". That never existed.

## 4. Snapshot file format (`.wsnap`) — planned / unused

`snapshots::writer::SnapshotWriter` can write a standalone `{seq:08}.wsnap` file, and a test-only helper reads it back (tests: `snapshots::writer::tests::write_and_read_back`, `snapshots::writer::tests::crc_mismatch_detected`). Its layout is: magic `b"WSNAP"` (5 bytes), version `u8`, flags `u16`, `commit_seq` `u64`, a 32-byte projection state hash, `commit_seq` again, and a CRC32C. It holds a hash, not projection state. Nothing in the engine or the server calls it, so no `.wsnap` file exists on a real data directory.

The checkpoint the engine uses is `projections/snapshot.json`, which stores the applied watermark and the index entries (test: `engine::locks::tests::snapshot_never_overclaims_watermark_coverage`). The `b"WSNP"` layout with BSATN state that this section used to describe was never written by any code.

### 4.1 The SQLite read model (`projections/read-model.sqlite3`)

Messages and channels are kept in SQLite instead (ADR-0001, Tasks 3.5.1 and 3.5.2): `projections/read-model.sqlite3`, with the latest row of each message in `messages`, one row per message event in `message_versions`, and one row per channel in `channels` (`key` the channel id's bytes, `record` the channel as JSON, the bytes the in-memory index held) (`projections/read_model/schema.rs`, schema version 2). Neither projection is in `snapshot.json`. `applied_commit_seq` has one row per projection (`messages`, `channels`); every commit writes both in one transaction, and the engine reads the lower one. What holds for that file:

- **Derived.** It is built from the log. Deleting it from a stopped engine changes no read (tests: `tests::read_model_messages::deleting_the_read_model_file_changes_no_read`, `tests::read_model_channels::deleting_the_read_model_file_changes_no_channel_read`). Replay therefore must store the same bytes every time: a channel row that an update creates (or rebuilds from an undecodable row) has creation time 0, not the clock at apply time as before this change. Compaction is not an event, so a rebuild brings compacted rows back (same test).
- **Not encrypted, mode 0600.** It holds message bodies as the snapshot did; SQLite's `-wal` and `-shm` side files get the same mode (tests: `tests::read_model_messages::the_read_model_file_is_owner_only_and_messages_leave_the_snapshot`, `projections::read_model::tests::the_file_and_its_write_ahead_log_are_created_owner_only`).
- **One transaction per commit.** A commit's rows and its `applied_commit_seq` are committed together, so a reader sees a commit whole or not at all, and a commit whose handler fails keeps none of its rows (tests: `tests::read_model_messages::concurrent_readers_never_see_part_of_a_commit`, `tests::read_model_messages::a_commit_that_fails_to_apply_stores_none_of_its_messages`, `tests::read_model_channels::a_commits_channel_rows_and_its_applied_commit_seq_become_visible_together`, `tests::power_loss::crash_after_a_channel_commit_keeps_its_rows_and_watermark_together`).
- **Generation.** The file records a schema version and a read-model generation (`READ_MODEL_GENERATION`). A file from another generation is replaced and rebuilt from the log (tests: `tests::read_model_messages::a_read_model_of_another_generation_is_rebuilt_from_the_log`, `tests::read_model_channels::a_read_model_of_another_generation_is_rebuilt_and_channel_reads_are_unchanged`). Whoever changes a record version or what a handler stores must bump the generation; a pinned hash of the stored rows of each projection fails until they do (tests: `projections::messages::tests::stored_rows_are_pinned_to_the_read_model_generation`, `projections::channels::tests::stored_rows_are_pinned_to_the_read_model_generation`). Generation 2 and schema version 2 are the first with channels.
- **Two watermarks.** A checkpoint first makes the read model durable at the watermark, then writes `snapshot.json`. At startup a read model ahead of the snapshot is kept and replay skips the message and channel events it holds; one that is missing, unusable or behind the snapshot is rebuilt from the whole log (the other projections load from the snapshot) (tests: `tests::read_model_messages::a_read_model_ahead_of_the_snapshot_is_kept_and_replay_skips_its_events`, `tests::read_model_messages::a_read_model_behind_the_snapshot_is_rebuilt_from_the_log`, `tests::read_model_channels::a_read_model_behind_the_snapshot_is_rebuilt_with_the_same_channel_reads`, `tests::power_loss::crash_between_read_model_sync_and_snapshot`, `tests::power_loss::crash_between_read_model_sync_and_snapshot_keeps_channels`).
- **An in-memory projection that reads the read model while it applies.** Room placement checks that the channel of a placement initialization was created in the same commit, by reading the `channels` table through the writer connection (it sees its own commit's rows). When the read model is ahead of the snapshot, replay gives the commits between the two to room placement again while the `channels` table already holds the later state, in which that channel may have been deleted. For a commit at or below the read model's watermark the check is skipped: that commit passed it when it was first applied, because the read model keeps a commit only once every handler of it succeeded. Without this, a crash after creating and deleting a placed channel made the next start refuse a healthy directory (tests: `tests::read_model_channels::a_read_model_ahead_of_the_snapshot_replays_placements_of_deleted_channels`, `tests::power_loss::crash_between_read_model_sync_and_snapshot_keeps_channels`). Reads outside applying a commit (admission checks, the server, tools) see only committed rows.
- **Startup replay is one transaction.** If replay fails, the file holds nothing replay wrote (tests: `tests::read_model_messages::a_failed_startup_replay_leaves_none_of_its_messages_in_the_file`, `tests::read_model_channels::a_failed_startup_replay_leaves_none_of_its_channels_in_the_file`).
- **Never rebuilt from a short log.** If the commit index ends below the snapshot's watermark or the read model's, the log has lost commits. The engine then starts only if the read model is usable and at exactly the snapshot's watermark; otherwise it refuses with "repair required" (tests: `tests::read_model_messages::a_checkpoint_that_outlived_its_log_opens_when_both_stores_agree`, `tests::read_model_messages::a_log_shorter_than_the_checkpoint_is_never_rebuilt_from`). The sequencer always continues above the snapshot's watermark, the read model's (even a file that is then replaced or that the start refuses) and the manifest's recorded height (tests: `tests::read_model_messages::the_next_commit_is_above_the_manifests_recorded_height`, `tests::read_model_messages::an_unusable_read_model_claiming_more_than_the_log_is_refused_and_its_claim_is_kept`).
- **A directory recorded as having an incomplete log.** The first start that keeps both saved projections over a short log writes `global/incomplete-log.json` (`{"version":1,"incomplete_below":N}`, N the commit both agreed on), atomically, and the same number into `storage-manifest.json` (`incomplete_log_below`) and into every snapshot written afterwards (`incomplete_log_below`). The engine takes the largest of the three, so removing the record file alone changes nothing. From then on **no rebuild from the log is ever allowed**, even after more commits have raised the commit index above both watermarks, and a start with no snapshot at or above N refuses too (its in-memory projections would be rebuilt from inside the hole). Any start that would need a rebuild (a lost read model, a rebuild request, a generation change, a quarantine) refuses and says the log is incomplete below N. Every start of such a directory logs a warning; `wabidb-cli check` and `verify` report a warning when it opens and an error when a start would refuse; `wabidb-cli quarantine` refuses up front. The record lies under `global/` so a live checkpoint carries it (tests: `tests::read_model_messages::a_directory_recorded_as_incomplete_never_rebuilds_from_its_log`, `tests::read_model_messages::removing_the_record_alone_does_not_allow_a_rebuild`, `tests::read_model_messages::a_copy_without_the_read_model_keeps_the_record_and_refuses`, `tests::read_model_messages::quarantine_refuses_a_directory_recorded_as_incomplete`, `tests::read_model_messages::an_unreadable_incomplete_log_record_refuses_startup`, `tests::read_model_messages::plan_startup_never_rebuilds_a_directory_recorded_as_incomplete`, `instance_archive::live::tests::the_incomplete_log_record_is_exported`). **What lifts it:** restoring the whole data directory from a backup taken before the log lost its commits (which replaces all three copies and loses the commits written since). Copying only the missing log files back does not work once commits were written after the loss: the new commits use the same index and segment file names, so a copy that does not overwrite restores nothing and one that does destroys them (same removal test).
- **Commit numbers can be missing without any loss.** A command rejected before anything is written burns its number, also before the first commit (an index can start above 1); a command that fails to prepare burns its number; a crash between a segment write and the index append leaves an orphan record with no index entry. None of these leaves a trace, so "the commit index is contiguous from 1" is not a test for a hole and would refuse healthy installations (test: `tests::read_model_messages::commit_numbers_can_have_gaps_that_leave_no_trace`; orphans: `sequencer::tests::orphan_records_tolerated`). What the engine checks instead: the manifest's `log_head_commit` (the lowest indexed commit, recorded once the directory has a log and nothing is known to be missing) can only move down; an index that starts higher than recorded means the log's head was lost and is treated as an incomplete log below the new first commit (test: `tests::read_model_messages::a_lost_log_head_is_noticed`). **A hole made before this build ever started, by an older build that kept writing, shows nowhere in the index.** The one evidence left is the old snapshot: see the next point.
- **A rebuild rebuilds only what the read model holds (messages and channels).** When the read model is missing, unusable or behind the snapshot, the start replays the whole log into the read model only. Every other projection loads from `snapshot.json` exactly as it does without a rebuild, including the open-time repairs (membership, voice, album ID index), and replay then applies the commits above the snapshot's watermark to all projections as always. Stale rows in those projections stay, as they did before the read model existed; a hole in the log that lost no message loses nothing the snapshot held. Message and channel handlers read nothing but the read model while they apply (`Projection::stores_in_read_model`), so applying them below the watermark cannot see a projection from a different point in time. A quarantined commit's message or channel change is not rebuilt. The rebuild still refuses over a log shorter than the snapshot or a directory recorded as incomplete, because the messages cannot then be rebuilt (tests: `tests::read_model_messages::a_rebuild_keeps_the_snapshots_other_projections_and_rebuilds_the_messages`, `tests::read_model_messages::a_rebuild_takes_the_messages_from_the_log_whatever_the_snapshot_covers`, `tests::read_model_messages::the_log_head_is_recorded_only_by_a_start_that_succeeds`).
- **Commit number limit.** No file may name a commit above 2^62. The sequencer refuses to allocate one: that commit fails cleanly with "commit number limit reached", nothing is written and the engine halts. A manifest at the limit opens, and its first commit is refused (test: `tests::read_model_messages::commit_numbers_stop_at_the_limit`).
- **Do not open the live read model with other tools.** The read gate holds back this store's own readers only. A reader in another process that keeps a read transaction open (an `sqlite3` shell, a backup tool copying the live file) pins the write-ahead log: 344 MiB of log over 8,000 commits and a 118 ms commit every 16 commits were measured. Copy the read model only with the engine stopped.
- **What a refused start may touch.** It changes no saved projection: the probe opens the read model read-only (immutable when its write-ahead log is empty, so it creates no file; an ordinary read-only connection when the log holds frames), so it never folds the log into the file or removes it. It may raise `highest_commit_seq` in `storage-manifest.json` (written atomically) to the highest commit any file names, so that deleting the file that claimed a commit cannot let a later start reuse those numbers, and SQLite may recreate `projections/read-model.sqlite3-shm`, an index it rebuilds. Every refusal says so (tests: `tests::read_model_messages::a_refusal_from_an_unclean_stop_leaves_the_database_and_its_log_as_they_were`, `tests::read_model_messages::probing_a_cleanly_stopped_read_model_creates_and_removes_nothing`, `tests::read_model_messages::an_unusable_read_model_claiming_more_than_the_log_is_refused_and_its_claim_is_kept`).
- **Implausible numbers.** A manifest height or a snapshot watermark above 2^62, or a read model whose `applied_commit_seq` is, is damage, not a count of commits: the manifest and snapshot make startup refuse and the read model is unusable (test: `tests::read_model_messages::an_implausible_manifest_height_or_watermark_is_a_corrupt_directory`).
- **Damage.** The file is checked with `PRAGMA quick_check` at every open; a damaged file is replaced and rebuilt when the log is whole (and no incomplete-log record exists), and kept, with startup refused, when it is not (test: `tests::read_model_messages::a_damaged_read_model_is_rebuilt_from_a_whole_log_and_kept_when_the_log_is_short`). Damage SQLite reports while running makes the engine unhealthy **and halted**: the sequencer refuses every command, of any kind, before it writes anything, as it does after a commit it could not apply, and `/readyz` is 503. The flag never clears: one read that returns a damage code, even one caused by a bad disk read that would not repeat, keeps the engine halted until the process is restarted. The engine leaves `projections/read-model.rebuild`, which makes the next start rebuild (tests: `tests::read_model_messages::damage_at_run_time_makes_the_engine_unhealthy_and_the_next_start_rebuilds`, `projections::read_model::tests::damage_seen_at_run_time_marks_the_store_and_requests_a_rebuild`).
- **Rebuild request.** `projections/read-model.rebuild` is written durably (file synced, then its directory). A request beside a missing file is cleared by the start that creates the new one, so it does not cause a second rebuild; a request that is not a regular file makes startup refuse instead of being ignored (tests: `tests::read_model_messages::a_stale_rebuild_request_is_cleared_when_the_file_it_was_for_is_gone`, `tests::read_model_messages::a_rebuild_request_that_is_a_directory_is_refused`).
- **Write-ahead log.** SQLite can restart its log only when no reader uses it, so readers that always overlap make it grow by every commit (110 MB beside a 3.7 MB database in 3,000 commits). When the log is above 32 MiB (checked every 16 commits and at every checkpoint) the store holds new read statements back for at most 50 ms while the running ones finish, then truncates it. No commit or checkpoint waits for a reader longer than that cap, and the log stays near the threshold as long as the statements running when the gate closes finish within 50 ms (true of every read except the unfiltered full scan of `MessagesProjection::query`; while such scans keep overlapping the log can exceed the threshold). Test: `projections::read_model::tests::the_write_ahead_log_stays_bounded_while_readers_never_pause` (295 MB without the trim, 1.8 MB with a 1 MiB threshold, longest commit or sync 37 ms) and `projections::read_model::tests::a_reader_pinned_for_a_long_time_cannot_hold_a_checkpoint`.
- **Quarantine.** `wabidb-cli quarantine` leaves the same rebuild request, so a commit the read model had applied is gone after the next start (test: `tests::read_model_messages::quarantining_a_commit_the_read_model_holds_removes_it_from_the_read_model`).
- **Directories written before this change are not supported.** This holds for directories written before Task 3.5.1 (messages) and before Task 3.5.2 (channels) alike: wipe them and start fresh. A directory from before 3.5.2 opens (its read model has schema version 1 and is rebuilt from the log), but its snapshot still holds a `channels` index that nothing reads any more and that every later snapshot carries along, so offline inspection of it is expected to refuse (read from the code, not tested). A snapshot saved before 3.5.1 still lists five message indexes; the engine ignores them on load (tests: `projections::message_lookup::tests::legacy_snapshot_message_indexes_are_not_loaded`, `tests::pre_versioning_fixture::opening_rebuilds_messages_from_the_log_not_the_snapshot`), so the messages come from the log. There is no check that the log still holds everything such a snapshot did, and no upgrade path is offered: wipe the directory and start fresh, or delete `projections/snapshot.json` and accept a full replay at your own risk.
- **Offline inspection** compares every row and column of the read model with a full replay when the directory holds a read model the engine would use as it is, after a full SQLite integrity check. It reports `readModelPresent`, `readModelCompared` and the reason when it did not compare (no file, or a file the engine would replace or rebuild). It refuses a file the engine would serve but that cannot be verified: a write-ahead log that still holds frames, a failed integrity check, or more commits than the checkpoint (test: `engine::offline_inspect::tests::read_model_rows_are_compared_and_a_changed_message_is_refused`).

Not measured or proven: behaviour under real power loss (the tests end the process, the operating system keeps its buffers), and Windows.

## 5. Blob file format (`.bin` + `.meta`)

Each blob is two files: the data (`.bin`) and a metadata sidecar (`.meta`).

Nothing in the engine or the server calls `wabidb::blobs`: the engine never creates `blobs/`, and wabi-server keeps uploads in its own SHA-256 registry (`core/crates/wabi-server/src/blobs/`), outside the WabiDB directory. So a real data directory has no `blobs/`. The format below is what the tested writer produces; using it for uploads is *planned*.

### 5.1 Blob data (`.bin`)

The raw blob bytes at `blobs/<hash[0..2]>/<rest>.bin`, named by BLAKE3 hash; writing the same content again is a no-op (test: `blobs::write::tests::write_is_idempotent`). No test asserts the `<hash[0..2]>/<rest>.bin` layout: `blobs::write::tests::canonical_path_layout` checks only that the path contains "blobs", ends in ".bin" and is under the data directory. The layout is read from `BlobWriter::canonical_path` in `blobs/write.rs`. A maximum blob size of 4 GiB was designed (`wabidb-54`, chunking) but is *planned*; this writer enforces no such limit.

### 5.2 Blob metadata (`.meta`)

A text sidecar of three lines: `blake3=<hex>`, `size=<bytes>`, `created_at_micros=<n>` (test: `blobs::write::tests::metadata_sidecar_written`). It is not the binary `b"BMTA"` record with CRC that this section used to describe; no code writes that.

## 6. Storage manifest (`storage-manifest.json`)

A JSON file at `$DATA_DIR/storage-manifest.json`, created when the engine first opens a data directory (test: `engine::tests::open_creates_storage_manifest` asserts the file exists and contains `"schema_version": 1` and `"engine_version": "0.1.0"`). The engine writes these fields, and raises `highest_commit_seq` when it opens if replay finds a higher commit than recorded. That the five fields below are present is shown (an engine-written manifest deserializes into those five fields (test: `cli::verify::tests::real_engine_tree_verifies`)); no test covers the raise, which is read from `update_manifest_high_seq` in `engine/mod.rs`:

```json
{
  "schema_version": 1,
  "format_version": 1,
  "engine_version": "0.1.0",
  "created_at_micros": 1718901234567890,
  "highest_commit_seq": 12345
}
```

`wabidb-cli verify` reads this shape (test: `cli::verify::tests::real_engine_tree_verifies`).

*Planned, not implemented:* the `config` block, the per-stream `streams` list, a manifest hash for backups, and manifest-based restore checks. Earlier text called the manifest "the canonical backup artifact". The backup helpers that exist (`retention::manifest_backup`, `retention::data_backup`, `retention::verify_backup`) copy and hash files and are tested (`retention::manifest_backup::tests::backup_to_new_dir`, `retention::data_backup::tests::backup_populated`, `retention::verify_backup::tests::hash_mismatch_reported`), but no `wabidb-cli` command and no server route runs them. A backup today is a copy of the whole stopped data directory (see `docs/deployment/BACKUP_AND_RECOVERY.md`).

## 7. Versioning

Three kinds of on-disk structure carry a version that the engine checks, and one carries versions that only the CLI checks:

- **Stream segment header**: `format_version: u16`, `header_len: u16`. The decoder rejects an unsupported `format_version` or a `header_len` other than 48 with an error, not a panic (tests: `format::record::tests::unsupported_version_rejected`, `format::record::tests::wrong_header_len_rejected`).
- **Quarantine list** (`global/quarantine.json`): `version`, currently `1`. The engine refuses to start on any other value (test: `engine::quarantine_tests::unparseable_quarantine_file_refuses_startup`).
- **Durable records** of 30 types: a per-type version byte in a 15-byte header. See §7.1.
- **Storage manifest**: `schema_version` and `format_version`, both `1`. The engine writes them and never reads them back, so starting the engine is not a compatibility check. `wabidb-cli verify` reports any other value as an error (`cli/verify.rs`); no test covers that refusal.

The commit-index file header also carries a `format_version`, but the reader does not check it (planned, see §3.5). The `.wsnap` and `.meta` layouts are unused or text, see §4 and §5.

*Planned:* a version-bump policy and a migration path for the file formats themselves (segment header, commit index, manifest). None exists. A change to a durable record goes through §7.1 (AGENTS.md golden rule 5). Future format changes must update this document.

### 7.1 Durable record header

A durable record of one of the 30 converted record types (the plaintext of its event, and the projection row made from it), and each of four event payloads that are not stored as rows (forum vote `FVOT`, forum solution `FSOL`, user-deleted `UDEL`, DM one-time-prekey consumed `DOTP`), is stored as:

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 10 | marker | `0xFF` ten times |
| 10 | 4 | tag | four ASCII bytes naming the record type, for example `b"MESG"`, `b"USER"`, `b"CMEM"` |
| 14 | 1 | version | layout version of that record type, starting at `1` |
| 15 | varies | payload | postcard encoding of that layout version |

(tests: `format::versioned::tests::header_layout_is_marker_tag_version_payload`, `tests::golden_records::every_durable_record_is_versioned`.)

- Records written before the header existed are raw postcard and still decode, through each type's legacy path (tests: `format::versioned::tests::missing_marker_uses_the_legacy_decoder`, and one `tests::golden_records::golden_*` test per type that holds the exact bytes the old encoder wrote). A whole data directory written before the change still opens and replays (tests: `tests::pre_versioning_fixture::pre_versioning_snapshot_still_decodes`, `tests::pre_versioning_fixture::pre_versioning_log_replays_to_the_same_state`, `tests::pre_versioning_fixture::pre_versioning_log_with_new_writes_replays`).
- The marker cannot begin a legacy record of these types. Each starts with a string, a `u64` or an `i64`, which postcard writes as a varint, and ten `0xFF` bytes in a row are not a valid varint (test: `format::versioned::tests::largest_legacy_varints_do_not_start_with_the_marker`). A record type that starts with a raw byte, a float or a fixed-size array is not covered by this argument.
- A wrong tag, an unknown version, a truncated header, or bytes left over after a versioned payload is an error, not a guess (tests: `format::versioned::tests::wrong_tag_is_an_error`, `format::versioned::tests::unknown_version_is_an_error_naming_the_version`, `format::versioned::tests::truncated_header_is_an_error`, `format::versioned::tests::versioned_payload_must_be_fully_used`).
- To change a record's fields: keep the old layout as its own struct, bump the version, and keep a decoder for every version ever written (test of the pattern: `format::versioned::tests::older_version_dispatches_to_its_own_decoder`). No record type has a version 2 yet.
- The change is one-way. A build from before the header cannot decode a record that has it; see `docs/deployment/BACKUP_AND_RECOVERY.md`.
- Offline inspection compares a replay with the saved projection. It treats a version-1 record and its legacy bytes as the same content, so a directory that spans the upgrade passes (tests: `format::versioned::tests::fingerprint_bytes_are_the_same_for_legacy_and_version_1`, `tests::pre_versioning_fixture::pre_versioning_directory_passes_offline_inspection`, `tests::pre_versioning_fixture::upgraded_directory_passes_offline_inspection`). That holds for version 1 only. A later version changes the payload, so a projection saved before that bump will not match a replay after it. Rebuilding the saved projection when a version changes is *planned*.
- The four event payloads were converted after the 30 record types, each with golden bytes captured first (tests: `tests::golden_records::golden_forum_vote_payload`, `tests::golden_records::golden_forum_solution_payload`, `tests::golden_records::golden_user_deleted`, `tests::golden_records::golden_dm_prekey_consumed_payload`), and old-format events of each still replay and pass offline inspection (tests: `tests::pre_versioning_fixture::raw_event_payloads_replay_in_both_formats`, `tests::pre_versioning_fixture::raw_event_payloads_pass_offline_inspection`). The `RecordCodec` trait has no default `encode`/`decode`, so an implementor cannot write a record without a version by omission (test: `tests::golden_records::record_codec_never_writes_unversioned_bytes`). Nothing writes the `dm_onetime_prekey_consumed` event today; its handler replays any that a data directory holds.

## 8. What this document does not specify

- The content of the payload for each `record_kind`. Beyond the version header in §7.1, an event payload is defined by the projection that owns it; the other kinds are planned.
- The exact layout of the data directory's internal organization beyond the structure shown in §1 (e.g., subdirectories for projection state are implementation detail of the engine's rebuild process, not part of the format).
- Wire format for WebSocket frames (covered in `wabidb-89`).
- The TOML config file format (covered in `wabidb-97`).

## 9. Cross-references

- `wabidb-04` (Custom byte primitives): the read/write/verify implementation of these structures.
- `wabidb-05` (Per-stream encryption primitive): how the `commit_seq` becomes the AES-GCM nonce, and how the AAD is computed.
- `wabidb-07` (Stream segment reader): the reader that consumes this format, including orphan skipping.
- `wabidb-13` (Global commit index record format): the implementation of §3.
- `wabidb-33` (Snapshot writer): the unused writer described in §4 (planned; not called by the engine).
- `wabidb-58` (BLAKE3 content addressing): the implementation of §5.
- `wabidb-62` (Manifest-based backup): design card; the manifest backup is planned (see §6).
- Endstate doc: `docs/proposals/wabidb-endstate.md` §11.1–11.5.
- Council Review #1 (wabidb-05/15): `docs/architecture/wabidb-council-reviews.md` §2.2 (Option B orphan skip).
