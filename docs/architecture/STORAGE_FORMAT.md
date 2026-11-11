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
│   └── snapshot.json               # the engine's projection checkpoint
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

Decoding rejects a header in which a bit of `commit_seq` (byte 12) was flipped (test: `format::record::tests::header_crc_mismatch_rejected`); that the checksum covers exactly bytes 0-39 is read from `RecordHeader::encode`/`decode` in `format/record.rs`, and no test flips a byte at the boundary (39 or 40). `verify_payload_crc` rejects a wrong payload and a wrong length (test: `format::record::tests::payload_crc_verification`), and the segment reader skips a record whose payload CRC fails (test: `stream_log::segment_reader::tests::corrupted_middle_record_is_skipped`). `stream_log::segment_reader::tests::non_zero_payload_crc_verified_by_reader` only reads back one record whose CRC is correct, so it is not cited for detection. That encrypted records write `0` here and rely on the GCM tag is read from `sequencer/mod.rs` (`RecordHeader::new(..., 0)`); no test covers it, and no test shows how the reader treats a `0` CRC.

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
4. The `header_crc32c` matches the CRC of bytes 0-39 (`header_crc_mismatch_rejected`).
5. The `record_kind` is one of `{1, 2, 3, 4}` (`unknown_record_kind_rejected`).
6. The `payload_len` is in `[0, 16 MiB]` (`oversized_payload_rejected`).
7. The `flags` field is `0` (`non_zero_flags_rejected`).

The payload CRC is checked separately when it is non-zero (`payload_crc_verification`).

The segment reader reads the valid prefix: a file cut at a record boundary yields the records before the cut (test: `stream_log::segment_reader::tests::truncated_tail_returns_valid_prefix`, which cuts exactly where record 4 begins), and it skips a record whose payload CRC fails (test: `stream_log::segment_reader::tests::corrupted_middle_record_is_skipped`). It also stops at a record cut in the middle, at an invalid header, and when the padding after a record is not all zeros; no test covers those three cases (read `stream_log/segment_reader.rs`: the header decode failure and `UnexpectedEof` branches return `None`, and "Check padding" handles the padding). It never modifies the file.

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

## 5. Blob file format (`.bin` + `.meta`)

Each blob is two files: the data (`.bin`) and a metadata sidecar (`.meta`).

Nothing in the engine or the server calls `wabidb::blobs`: the engine never creates `blobs/`, and wabi-server keeps uploads in its own SHA-256 registry (`core/crates/wabi-server/src/blobs/`), outside the WabiDB directory. So a real data directory has no `blobs/`. The format below is what the tested writer produces; using it for uploads is *planned*.

### 5.1 Blob data (`.bin`)

The raw blob bytes at `blobs/<hash[0..2]>/<rest>.bin`, named by BLAKE3 hash; writing the same content again is a no-op (test: `blobs::write::tests::write_is_idempotent`). No test asserts the `<hash[0..2]>/<rest>.bin` layout: `blobs::write::tests::canonical_path_layout` checks only that the path contains "blobs", ends in ".bin" and is under the data directory. The layout is read from `BlobWriter::canonical_path` in `blobs/write.rs`. A maximum blob size of 4 GiB was designed (`wabidb-54`, chunking) but is *planned*; this writer enforces no such limit.

### 5.2 Blob metadata (`.meta`)

A text sidecar of three lines: `blake3=<hex>`, `size=<bytes>`, `created_at_micros=<n>` (test: `blobs::write::tests::metadata_sidecar_written`). It is not the binary `b"BMTA"` record with CRC that this section used to describe; no code writes that.

## 6. Storage manifest (`storage-manifest.json`)

A JSON file at `$DATA_DIR/storage-manifest.json`, created when the engine first opens a data directory (test: `engine::tests::open_creates_storage_manifest` asserts the file exists and contains `"schema_version": 1` and `"engine_version": "0.1.0"`). The engine writes these fields, and raises `highest_commit_seq` when it opens if replay finds a higher commit than recorded. No test covers the full field list or the raise; both are read from the `open` function in `engine/mod.rs` (step 4) and `update_manifest_high_seq`:

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

A durable record of one of the 30 converted types (the plaintext of its event, and the projection row made from it) is stored as:

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
- *Planned* (plan Task 3.1b): four event payloads are still raw postcard with no version: the forum vote and solution payloads, the user-deleted payload, and the DM one-time-key "consumed" payload. The `RecordCodec` trait's default `encode`/`decode` also still write raw postcard; nothing calls them for a converted type today.

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
