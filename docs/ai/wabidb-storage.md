# WabiDB Storage Format

On-disk layout for the WabiDB event-sourced database.

## Data directory

```
$DATA_DIR/
├── manifests/storage-manifest.json
├── commit-index/
│   └── *.widx
├── streams/<kind>/<stream_id>/
│   ├── 00000001.wseg
│   ├── 00000002.wseg
│   └── *.wsnap
├── blobs/
│   ├── <hash>.bin
│   └── <hash>.meta
└── wabidb/.lock
```

Stream ID format: `kind_ULID` (e.g., `ch_01JABCDEF...`). Segment files: zero-padded 8-digit numbers.

## Stream segment format (.wseg)

Append-only, max ~64 MiB each. Each record:

```
48-byte RecordHeader + variable payload + 16-byte padding
```

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
- Payload CRC32C: covers entire payload

Payload by record kind:
- **Event (1)**: AES-256-GCM encrypted event data
- **Snapshot (2)**: BLAKE3-keyed serialized state
- **Tombstone (3)**: empty payload (existence = deletion signal)
- **Checkpoint (4)**: high-water-mark for projection rebuilds

Validation: 9 checks for valid record. Segment validity = prefix of valid records terminated by EOF or invalid record. Orphan handling: valid records not in commit index are skipped (Option B rollback).

## Commit index format (.widx)

Global ordering log. File header (16 bytes):
- Magic: `b"WIDX"` (0x57 0x49 0x44 0x58)
- Format version: u16 (1)
- Flags: u16 (0x0000 = current/appending, 0x0001 = sealed)
- Entry count: u32 (max 10,000)
- Header CRC32C: bytes 0-12

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
- Entry CRC32C

StreamRef (29 bytes): stream ID hash, stream kind, segment ID, offset, length.

File trailer (32 bytes): highest commit sequence, file CRC32C, reserved.

## Snapshot format (.wsnap)

Magic `b"WSNP"`, format version u16, commit_seq u64, stream ID hash [u8; 16], state length u32, state CRC32C, state data (BSATN serialized projection state).

## Blob storage

Two-file system:
- `.bin` — raw blob data, max 4 GiB
- `.meta` — magic `b"BMTA"`, format version, BLAKE3 content hash [u8; 32], size u32, CRC32C

## Storage manifest (JSON)

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
  "streams": [...]
}
```

## Versioning

- Minor version bump: old readers can ignore new fields
- Major version bump: old readers cannot parse new format
- Reader behavior: reject unsupported versions (don't panic)