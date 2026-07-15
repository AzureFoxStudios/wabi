# WabiDB Storage Format Specification

> **Card:** wabidb-02 (Phase 1, Storage Format)
> **Status:** v1 specification
> **Source of truth:** `docs/proposals/wabidb-endstate.md` §11.1–11.5
> **Date:** 2026-06-20

This document is the authoritative byte-level specification of the WabiDB on-disk format. It is the contract that the writer code (`wabidb::stream_log::segment_writer`) and the reader code (`wabidb::stream_log::segment_reader`) must agree on. The `wabidb-04` implementation card (Custom byte primitives) implements the read/write helpers for these structures.

All multi-byte integers are **little-endian**. All CRCs are **CRC32C** (Castagnoli polynomial, `0x1EDC6F41`).

## 1. Data directory layout

```
$DATA_DIR/
├── streams/
│   ├── channel/
│   │   └── ch_01J.../              # one directory per stream
│   │       ├── events/
│   │       │   ├── 00000001.wseg   # segment files, 64 MiB max each
│   │       │   ├── 00000002.wseg
│   │       │   └── ...
│   │       └── snapshots/
│   │           └── 00000001.wsnap
│   ├── dm/
│   │   └── dm_01J.../
│   │       ├── events/
│   │       │   └── 00000001.wseg
│   │       └── snapshots/
│   │           └── 00000002.wsnap
│   └── whiteboard/
│       └── wb_01J.../
│           ├── patches/
│           │   └── 00000001.wseg
│           └── snapshots/
│               └── 00000003.wsnap
├── global/
│   └── commit-index/
│       ├── 00000001.widx           # sealed index files
│       ├── 00000002.widx
│       └── 00000003.widx           # current (still appending)
├── blobs/
│   ├── ab/
│   │   ├── abcd....bin
│   │   └── abcd....meta
│   ├── cd/
│   │   └── ...
│   └── manifests/
│       └── storage-manifest.json
└── manifests/
    └── storage-manifest.json
```

Stream ID format: `kind_ULID` where kind is one of `ch`, `dm`, `wb`, `pl`, `kb` (channel, dm, whiteboard, place, kanban). ULIDs are 26 characters of Crockford base32.

Segment file numbering: monotonically increasing `u64` zero-padded to 8 digits, suffix `.wseg`. The first segment for a stream is `00000001.wseg`. The next segment is created when the current one reaches 64 MiB OR when the stream is rotated.

## 2. Stream segment file format (`.wseg`)

A stream segment file is a sequence of records. Each record has a 36-byte header, a variable-length payload, and 16-byte alignment padding.

### 2.1 Record header (36 bytes)

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 4 | `magic` | `[u8; 4]` | Always `b"WABI"` (`0x57 0x41 0x42 0x49`) |
| 4 | 2 | `format_version` | `u16` | Current: `1` |
| 6 | 2 | `header_len` | `u16` | Current: `36` (allows future expansion) |
| 8 | 2 | `record_kind` | `u16` | 1=event, 2=snapshot, 3=tombstone, 4=checkpoint |
| 10 | 2 | `flags` | `u16` | Reserved, must be `0` |
| 12 | 8 | `commit_seq` | `u64` | Monotonic per stream; matches the global commit index entry |
| 20 | 16 | `stream_id_hash` | `[u8; 16]` | First 16 bytes of `BLAKE3(stream_id)` |
| 36 | 4 | `payload_len` | `u32` | Length of payload in bytes; max `16 MiB` (`0x0100_0000`) |
| 40 | 4 | `header_crc32c` | `u32` | CRC32C of header bytes `[0..40)` (i.e., the header up to but not including this field and the payload CRC) |
| 44 | 4 | `payload_crc32c` | `u32` | CRC32C of payload bytes `[52..52+payload_len)` |

**Total header size: 48 bytes** (not 36 — the 36 figure in the endstate doc predates the `payload_crc32c` field; the implementation must use 48).

The `header_crc32c` covers bytes 0-39 (the first 40 bytes of the header, before the header CRC field). The `payload_crc32c` covers the entire payload.

### 2.2 Payload

Immediately follows the header. Length is `payload_len` bytes (range `[0, 16 MiB]`).

For `record_kind = 1 (event)`: the payload is the encrypted event. The plaintext event is serialized via BSATN or bincode (per `wabidb-14`), then encrypted with AES-256-GCM using the stream's key (per `wabidb-05`). The 12-byte nonce is `commit_seq` as little-endian u64 padded to 12 bytes (zeros in the high 4 bytes). The AAD is the first 40 bytes of the header (`magic` through `header_len` field inclusive). The GCM authentication tag (16 bytes) is appended to the payload; the on-disk payload length therefore includes the tag.

For `record_kind = 2 (snapshot)`: the payload is the snapshot's serialized state (BLAKE3-keyed for tamper detection, per `wabidb-33`).

For `record_kind = 3 (tombstone)`: the payload is empty. The record's existence is the signal that the stream is destroyed (per `wabidb-39` cryptographic deletion).

For `record_kind = 4 (checkpoint)`: the payload is a high-water-mark checkpoint for projection rebuilds (per `wabidb-28`).

### 2.3 Padding

After the payload, the record is padded with zero bytes to the next 16-byte boundary. The padding is not counted in `payload_len`.

Total record size = `48 (header) + payload_len + padding`, where `padding` is the smallest non-negative integer such that the total is a multiple of 16.

### 2.4 Record validity

A record is **valid** iff all of:
1. The header magic equals `b"WABI"`.
2. The `format_version` is in the set of supported versions (currently `{1}`).
3. The `header_len` equals 48.
4. The `header_crc32c` matches the CRC of bytes 0-39.
5. The `payload_crc32c` matches the CRC of the payload.
6. The `record_kind` is in the supported set `{1, 2, 3, 4}`.
7. The `payload_len` is in `[0, 16 MiB]`.
8. The `flags` field is `0`.
9. The padding is all zeros (otherwise the segment may have been truncated mid-record; treat as invalid).

A stream segment is **valid** iff records 0..N are valid and record N+1 begins with an invalid header (i.e., the segment is a prefix of valid records terminated by either EOF or an invalid record). Recovery scans sequentially, truncates at the first invalid record, and resumes from the last valid offset.

Records that are valid but absent from the global commit index are **orphans** (allowed by Option B rollback, per Council Review #1 §2.2 in `docs/architecture/wabidb-council-reviews.md`). The reader skips them silently.

## 3. Global commit index file format (`.widx`)

A commit index file is a sequence of fixed-size entries (the on-disk record format is a `u32` entry count followed by that many entries, then a 32-byte trailer).

### 3.1 File header (16 bytes)

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 4 | `magic` | `[u8; 4]` | Always `b"WIDX"` (`0x57 0x49 0x44 0x58`) |
| 4 | 2 | `format_version` | `u16` | Current: `1` |
| 6 | 2 | `flags` | `u16` | `0x0001` = sealed (no more appends), `0x0000` = current (still being appended) |
| 8 | 4 | `entry_count` | `u32` | Number of entries that follow; max `10_000` |
| 12 | 4 | `header_crc32c` | `u32` | CRC32C of bytes `[0..12)` |

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
| 61 | 32 | `idempotency_key_hash` | `[u8; 32]` | `BLAKE3(caller_user_id || caller_device_id || client_request_id)`, present iff `has_idempotency_key == 1` |
| 93 | 4 | `event_ref_count` | `u32` | Number of `StreamRef` entries that follow |
| 97 | ... | `event_refs` | `StreamRef[]` | 1..N event references |
| ... | 4 | `entry_crc32c` | `u32` | CRC32C of bytes `[4..entry_crc32c)` |

### 3.3 StreamRef (29 bytes each)

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 16 | `stream_id_hash` | `[u8; 16]` | First 16 bytes of `BLAKE3(stream_id)` |
| 16 | 1 | `stream_kind` | `u8` | 1=channel, 2=dm, 3=whiteboard, 4=place, 5=kanban, 6=other |
| 17 | 8 | `segment_id` | `u64` | Which `.wseg` file the record lives in |
| 25 | 4 | `offset` | `u32` | Byte offset within the segment (the start of the record header) |
| 29 | 4 | `length` | `u32` | Total record size on disk (header + payload + padding) |

### 3.4 File trailer (32 bytes)

After the last entry, the file has a 32-byte trailer:

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 8 | `highest_commit_seq` | `u64` | The `commit_seq` of the last entry; redundant with the entries but quick to read on startup |
| 8 | 4 | `file_crc32c` | `u32` | CRC32C of all bytes from offset 0 to here (exclusive) |
| 12 | 20 | `reserved` | `[u8; 20]` | All zeros; reserved for future fields |

### 3.5 Validity

A commit index file is **valid** iff:
1. Header magic equals `b"WIDX"`.
2. Header `format_version` is in the supported set.
3. Header `header_crc32c` matches.
4. Each entry's `entry_crc32c` matches.
5. `event_ref_count` is consistent with the number of `StreamRef` records.
6. The trailer `file_crc32c` matches.

Recovery reads the latest index file (highest `commit_seq`) plus any in-progress append in the current file. A corrupt current file is truncated to the last valid entry and re-sealed.

## 4. Snapshot file format (`.wsnap`)

A snapshot file holds the serialized state of a projection at a specific `commit_seq`. It is logically similar to a `.wseg` record of `record_kind = 2` but stored as a standalone file for efficient recovery.

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 4 | `magic` | `[u8; 4]` | Always `b"WSNP"` (`0x57 0x53 0x4E 0x50`) |
| 4 | 2 | `format_version` | `u16` | Current: `1` |
| 6 | 2 | `flags` | `u16` | Reserved, `0` |
| 8 | 8 | `commit_seq` | `u64` | The `commit_seq` at which this snapshot was taken |
| 16 | 16 | `stream_id_hash` | `[u8; 16]` | First 16 bytes of `BLAKE3(stream_id)` |
| 32 | 4 | `state_len` | `u32` | Length of the serialized state |
| 36 | 4 | `state_crc32c` | `u32` | CRC32C of the state |
| 40 | ... | `state` | bytes | Serialized projection state (BSATN) |

## 5. Blob file format (`.bin` + `.meta`)

Each blob is two files: the data (`.bin`) and a metadata sidecar (`.meta`).

### 5.1 Blob data (`.bin`)

The raw blob bytes. Maximum size: 4 GiB (per the chunking design in `wabidb-54`).

### 5.2 Blob metadata (`.meta`)

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 4 | `magic` | `[u8; 4]` | Always `b"BMTA"` (`0x42 0x4D 0x54 0x41`) |
| 4 | 2 | `format_version` | `u16` | Current: `1` |
| 6 | 2 | `flags` | `u16` | Reserved, `0` |
| 8 | 32 | `content_hash` | `[u8; 32]` | BLAKE3 hash of the data file (must match) |
| 40 | 4 | `size` | `u32` | Size of the data file in bytes |
| 44 | 4 | `meta_crc32c` | `u32` | CRC32C of bytes `[0..44)` |

## 6. Storage manifest (`storage-manifest.json`)

A JSON file at `$DATA_DIR/manifests/storage-manifest.json`. Schema:

```json
{
  "schema_version": 1,
  "format_version": 1,
  "highest_commit_seq": 12345,
  "engine_version": "0.1.0",
  "created_at_micros": 1718901234567890,
  "config": {
    "segment_size_bytes": 67108864,
    "commit_batch_size": 10,
    "commit_batch_age_micros": 50000,
    "backpressure_timeout_micros": 5000000,
    "reaper_interval_micros": 60000000,
    "snapshot_threshold_events": 10000,
    "snapshot_threshold_age_micros": 86400000000,
    "load_shed_backlog_threshold": 50000
  },
  "streams": [
    {
      "stream_id": "ch_01H...",
      "stream_kind": 1,
      "stream_key_id": "01H...",
      "segment_count": 3,
      "total_record_count": 15234,
      "total_size_bytes": 8923456,
      "created_at_micros": 1718901234567890,
      "last_commit_seq": 12345
    }
  ]
}
```

The manifest is the canonical backup artifact (per `wabidb-62` manifest-based backup and `wabidb-86` backup format). A backup is a directory copy of the data dir plus a frozen manifest.

## 7. Versioning

The on-disk format has explicit version fields at every level:

- **Stream segment header**: `format_version: u16`, `header_len: u16`. A reader that sees an unsupported `format_version` or a `header_len` it doesn't recognize must reject the segment (not panic).
- **Commit index file header**: `format_version: u16`. Unsupported versions are rejected.
- **Snapshot file header**: `format_version: u16`. Same.
- **Blob metadata header**: `format_version: u16`. Same.

Adding a new field is a **minor version bump** (1 → 2) if old readers can ignore it; a **major version bump** (1 → 3) if old readers cannot. The first reader that supports a new version must update the writer's `format_version` to match.

The endstate doc is currently at v1. Future format changes must update this document and add a migration entry to `wabidb-90` (migration plan) or `wabidb-28` (rebuild).

## 8. What this document does not specify

- The content of the payload for each `record_kind` (covered in `wabidb-04` for records, `wabidb-33` for snapshots, `wabidb-39` for tombstones).
- The exact layout of the data directory's internal organization beyond the structure shown in §1 (e.g., subdirectories for projection state are implementation detail of the engine's rebuild process, not part of the format).
- Wire format for WebSocket frames (covered in `wabidb-89`).
- The TOML config file format (covered in `wabidb-97`).

## 9. Cross-references

- `wabidb-04` (Custom byte primitives): the read/write/verify implementation of these structures.
- `wabidb-05` (Per-stream encryption primitive): how the `commit_seq` becomes the AES-GCM nonce, and how the AAD is computed.
- `wabidb-07` (Stream segment reader): the reader that consumes this format, including orphan skipping.
- `wabidb-13` (Global commit index record format): the implementation of §3.
- `wabidb-33` (Snapshot writer): the implementation of §4.
- `wabidb-58` (BLAKE3 content addressing): the implementation of §5.
- `wabidb-62` (Manifest-based backup): the implementation of §6.
- Endstate doc: `docs/proposals/wabidb-endstate.md` §11.1–11.5.
- Council Review #1 (wabidb-05/15): `docs/architecture/wabidb-council-reviews.md` §2.2 (Option B orphan skip).
