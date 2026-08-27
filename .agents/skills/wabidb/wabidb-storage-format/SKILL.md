---
name: wabidb-storage-format
description: "Learn WabiDB storage format specification from STORAGE_FORMAT.md"
version: 0.1.0
author: Hermes
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Storage, Format, WabiDB, Specification]
---

# WabiDB Storage Format Learning Guide

This skill provides a structured approach to learning the WabiDB storage format specification from the official STORAGE_FORMAT.md document.

## When to Use

- Need to understand WabiDB's on-disk data layout
- Planning to implement custom storage tools or viewers
- Debugging storage-related issues or corruption
- Building backup/restore utilities
- Learning WabiDB internals for development contributions

## Prerequisites

- Access to WabiDB source code (specifically `STORAGE_FORMAT.md`)
- Basic understanding of binary file formats
- Familiarity with concepts like CRC32C, little-endian encoding, and serialization
- Rust programming knowledge (for implementation references)

## How to Learn

Follow this structured approach to learn the WabiDB storage format:

## Procedure

### 1. Review Document Structure

Read through the STORAGE_FORMAT.md to understand its organization:
- Section 1: Data directory layout
- Section 2: Stream segment file format (.wseg)
- Section 3: Global commit index file format (.widx)
- Section 4: Snapshot file format (.wsnap)
- Section 5: Blob file format (.bin + .meta)
- Section 6: Storage manifest (storage-manifest.json)
- Sections 7-9: Versioning, limitations, and cross-references

### 2. Study Data Directory Layout

**Key Points to Learn:**
- Directory structure under `$DATA_DIR/`
- Stream types: channel (ch), direct message (dm), whiteboard (wb), place (pl), kanban (kb)
- Stream ID format: `kind_ULID` (e.g., `ch_01JABCDEF...`)
- Segment file naming: zero-padded 8-digit numbers with `.wseg` suffix
- Snapshot file naming: similar format with `.wsnap` suffix
- Commit index files: `.widx` extension
- Blob storage: `.bin` data files + `.meta` metadata files
- Manifest location: `$DATA_DIR/manifests/storage-manifest.json`

### 3. Master Stream Segment Format (.wseg)

**Focus Areas:**
- Record structure: 48-byte header + variable payload + 16-byte padding
- Header fields:
  - Magic: `b"WABI"` (0x57 0x41 0x42 0x49)
  - Format version: u16 (currently 1)
  - Header length: u16 (currently 48 bytes)
  - Record kind: u16 (1=event, 2=snapshot, 3=tombstone, 4=checkpoint)
  - Flags: u16 (must be 0)
  - Commit sequence: u64 (monotonic per stream)
  - Stream ID hash: [u8; 16] (first 16 bytes of BLAKE3(stream_id))
  - Payload length: u32 (max 16 MiB)
  - Header CRC32C: covers bytes 0-39
  - Payload CRC32C: covers entire payload
- Payload handling for each record type:
  - Event (1): AES-256-GCM encrypted event data
  - Snapshot (2): BLAKE3-keyed serialized state
  - Tombstone (3): empty payload (existence = deletion signal)
  - Checkpoint (4): high-water-mark for projection rebuilds
- Validation rules (9 checks for valid record)
- Segment validity: prefix of valid records terminated by EOF or invalid record
- Orphan handling: valid records not in commit index are skipped (Option B rollback)

### 4. Examine Commit Index Format (.widx)

**Key Components:**
- File header (16 bytes):
  - Magic: `b"WIDX"` (0x57 0x49 0x44 0x58)
  - Format version: u16 (currently 1)
  - Flags: u16 (0x0000 = current/appending, 0x0001 = sealed)
  - Entry count: u32 (max 10,000 entries)
  - Header CRC32C: bytes 0-12
- Entry structure (variable length):
  - Entry length: u32 (length of entry body)
  - Commit sequence: u64 (monotonic, never reused)
  - Timestamp: i64 (microseconds)
  - Caller user ID: u64 (0 = system)
  - Caller device ID hash: [u8; 16] (first 16 bytes of BLAKE3)
  - Command name hash: [u8; 16] (first 16 bytes of BLAKE3)
  - Has idempotency key: u8 (0 or 1)
  - Idempotency key hash: [u8; 32] (BLAKE3 of user||device||request) if present
  - Event reference count: u32
  - Event references: StreamRef[] array
  - Entry CRC32C: covers bytes [4..entry_crc32c)
- StreamRef structure (29 bytes):
  - Stream ID hash: [u8; 16]
  - Stream kind: u8 (1-6 for different types)
  - Segment ID: u64 (which .wseg file)
  - Offset: u32 (byte offset within segment)
  - Length: u32 (total record size on disk)
- File trailer (32 bytes):
  - Highest commit sequence: u64 (redundant with entries)
  - File CRC32C: covers entire file up to this point
  - Reserved: 20 bytes (zeros)

### 5. Analyze Snapshot Format (.wsnap)

**Important Details:**
- Magic: `b"WSNP"` (0x57 0x53 0x4E 0x50)
- Format version: u16 (currently 1)
- Flags: u16 (reserved, 0)
- Commit sequence: u64
- Stream ID hash: [u8; 16]
- State length: u32
- State CRC32C: u32
- State data: bytes (BSATN serialized projection state)

### 6. Review Blob Storage Format

**Two-file system:**
- Data file: `.bin` (raw blob data, max 4 GiB)
- Metadata file: `.meta` with:
  - Magic: `b"BMTA"` (0x42 0x4D 0x54 0x41)
  - Format version: u16 (currently 1)
  - Flags: u16 (reserved, 0)
  - Content hash: [u8; 32] (BLAKE3 of data file)
  - Size: u32 (data file size)
  - Meta CRC32C: u32 (covers bytes 0-44)

### 7. Study Storage Manifest

**JSON Structure:**
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

### 8. Understand Versioning System

**Key Concepts:**
- Explicit version fields at every format level
- Backward compatibility rules:
  - Minor version bump (1→2): old readers can ignore new fields
  - Major version bump (1→3): old readers cannot parse new format
- Reader behavior: reject unsupported versions (don't panic)
- Writer responsibility: update format_version when supporting new version

### 9. Review Cross-References

**Important Related Documents:**
- `wabidb-04`: Custom byte primitives implementation
- `wabidb-05`: Per-stream encryption (AES-GCM with commit_seq nonce)
- `wabidb-07`: Stream segment reader (includes orphan skipping)
- `wabidb-13`: Global commit index record format
- `wabidb-33`: Snapshot writer
- `wabidb-58`: BLAKE3 content addressing
- `wabidb-62`: Manifest-based backup
- Endstate doc: `docs/proposals/wabidb-endstate.md` §11.1–11.5
- Council Review #1: `docs/architecture/wabidb-council-reviews.md` §2.2

## Verification

Confirm your understanding by being able to:

1. **Diagram the directory structure** for a sample WabiDB data directory
2. **Describe the byte layout** of a typical event record in a .wseg file
3. **Explain how recovery works** when encountering invalid records
4. **Detail the commit index entry structure** and its relationship to stream references
5. **Distinguish between** the different record kinds and their payload handling
6. **Describe the validation process** for each file type
7. **Explain the versioning system** and compatibility rules
8. **Reference the implementation files** that correspond to each section

## Practice Exercises

To solidify your learning:

1. **Create a parser**: Write a simple program that can read and validate a .wseg file header
2. **Validate a commit index**: Implement checks for the .widx file structure
3. **Trace recovery**: Walk through how WabiDB would recover from a crash at each boundary point
4. **Compare formats**: Note differences between .wseg, .widx, .wsnap, and .bin/.meta files
5. **Check consistency**: Verify how the storage manifest reflects actual file counts and sizes

## Reference Implementation

Consult these source files for implementation details:
- `src/format/`: Contains the format definitions and helpers
- `src/stream_log/`: Segment reader/writer implementations
- `src/commit_index/`: Commit index handling
- `src/snapshot/`: Snapshot creation and reading
- `src/blobs/`: Blob storage implementation
- `src/cli/`: Storage CLI tools (wabidb check, dump-stream, etc.)

## Summary

By following this learning guide, you will gain a comprehensive understanding of:
- WabiDB's on-disk storage organization
- Binary format specifications for all file types
- Validation and recovery mechanisms
- Versioning and compatibility guarantees
- Relationship between different storage components
- Implementation references in the source code

This knowledge enables you to work confidently with WabiDB's storage layer for development, debugging, or tool creation purposes.