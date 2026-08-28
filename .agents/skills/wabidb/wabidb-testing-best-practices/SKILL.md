---
name: wabidb-testing-best-practices
description: "Learn WabiDB testing: unit, integration, property, fuzz, and crash."
---

# WabiDB Testing Best Practices

This skill provides a structured approach to learning WabiDB's testing strategies covering unit, integration, property, fuzz, crash, and benchmark testing.

## When to Use

- Implementing new WabiDB features or components
- Writing tests for storage systems or databases
- Learning about property-based testing in Rust
- Studying fuzz testing for binary formats
- Validating crash recovery mechanisms
- Designing integration tests for distributed systems
- Improving test coverage for existing code

## Prerequisites

- Access to WabiDB source code
- Rust toolchain (1.70+ recommended)
- `cargo` build system
- `proptest` crate for property testing
- Basic understanding of async testing in Rust
- Familiarity with WabiDB's core concepts (segments, commit index, projections)

## How to Run

Use these commands to execute different test types:

```bash
# Run all tests
cargo test -p wabidb

# Run unit tests
cargo test -p wabidb --lib

# Run integration tests
cargo test --features test-harness -p wabidb -- replay_test

# Run property tests
cargo test --features test-harness -p wabidb -- property_tests

# Run fuzz tests
cargo test --features test-harness -p wabidb -- fuzz

# Run benchmarks
cargo bench -p wabidb -- projection_read
```

## Quick Reference

| Test Type | Key Files | Commands | Purpose |
|-----------|-----------|----------|---------|
| Unit | `src/**/mod.rs` | `cargo test` | Validate individual components |
| Property | `src/tests/property_tests.rs` | `cargo test --features test-harness -p wabidb -- property_tests` | Property-based validation (16 tests) |
| Integration | `src/tests/replay_test.rs` | `cargo test --features test-harness -p wabidb -- replay_test` | End-to-end workflow validation |
| Crash | `src/tests/crash_tests.rs` | `cargo test --features test-harness -p wabidb -- crash_tests` | Power-loss recovery validation |
| Fuzz | `src/fuzz/mod.rs` | `cargo test --features test-harness -p wabidb -- fuzz` | Input validation and robustness (4 targets) |
| Benchmark | `benches/projection_read.rs` | `cargo bench -p wabidb -- projection_read` | Projection read performance (24 benchmarks) |

## Procedure

### 1. Unit Testing Best Practices

**Pattern**: Test individual components in isolation with clear input/output validation.

**Key Techniques**:
- Use `#[test]` attributes for individual test cases
- Test both happy paths and error conditions
- Validate state transitions and invariants
- Use temporary directories for filesystem operations
- Test serialization/deserialization round-trips

**Example Test Structure**:
```rust
#[test]
fn record_round_trip_minimal() {
    let header = RecordHeader::new(RecordKind::Event, 0, [0u8; 16], 0, 0);
    let bytes = header.encode();
    let decoded = RecordHeader::decode(&bytes).unwrap();
    assert_eq!(header, decoded);
}
```

**Projection Unit Test Patterns**:
Each projection with soft-delete (`is_deleted`) has a 3-test pattern:
- `fn delete_marks_record()` — verifies that setting `is_deleted = true` marks the record
- `fn list_*_filters_deleted()` — verifies that list excludes deleted by default but includes them when `include_deleted: true`
- `fn compact_removes_deleted()` — verifies that `compact()` physically removes deleted records

### 2. Property-Based Testing (Proptest)

WabiDB uses `proptest = "1"` for property-based testing. All 16 property tests are in `src/tests/property_tests.rs`.

**Existing Tests** (2):
- `record_encode_decode_round_trip` — RecordHeader encode/decode with generated commit_seq, payload_len, hashes
- `commit_index_encode_decode_round_trip` — CommitIndexEntry encode/decode with generated fields

**Projection Record Round-Trips** (5):
- `message_record_postcard_round_trip` — MessageRecord postcard encode/decode
- `wiki_page_record_postcard_round_trip` — WikiPageRecord postcard encode/decode
- `forum_post_record_postcard_round_trip` — ForumPostRecord postcard encode/decode
- `incident_record_postcard_round_trip` — IncidentRecord postcard encode/decode
- `user_record_postcard_round_trip` — UserRecord postcard encode/decode

**Key Encoding Injectivity** (3):
- `wiki_key_encode_decode_injective` — wiki encode_key determinism and collision resistance
- `forum_key_encode_decode_injective` — forum 3-part encode_key determinism
- `incident_key_encode_decode_injective` — incident encode_key determinism

**Domain Type JSON Round-Trips** (3):
- `wiki_page_json_round_trip` — WikiPage serde_json round-trip
- `forum_post_json_round_trip` — ForumPost serde_json round-trip
- `incident_json_round_trip` — Incident serde_json round-trip

**Strategy Patterns**:
```rust
fn short_string() -> impl Strategy<Value = String> {
    "[a-zA-Z0-9_/.-]{0,64}"
}

fn projection_round_trip<T: Serialize + DeserializeOwned + Debug + PartialEq>(record: &T) {
    let encoded = postcard::to_allocvec(record).expect("encode");
    let decoded: T = postcard::from_bytes(&encoded).expect("decode");
    assert_eq!(*record, decoded);
}
```

### 3. Integration Testing

Integration tests live in `src/tests/` as lib test modules (not in `tests/` directory):

- **`replay_test.rs`** — Full command-commit-readback flows that exercise the sequencer, segment writer, commit index, and projection dispatcher together.
- **`send_message_flow.rs`** — End-to-end message send: submit a `send_message` command, verify the `MessagesProjection` contains the new message.

These tests require the `test-harness` feature flag for engine initialization with test configs.

### 4. Fuzz Testing

4 inline fuzz targets in `src/fuzz/mod.rs` with 14 test cases each:

| Target | Input | Tests |
|--------|-------|-------|
| `fuzz_record_decode` | `RecordHeader::decode()` | empty, truncated, garbage, max-size |
| `fuzz_stream_ref_decode` | `StreamRef::decode()` | empty, truncated, garbage, max-size |
| `fuzz_commit_index_entry_decode` | `CommitIndexEntry::decode()` | empty, truncated, garbage, max-size |
| `fuzz_parse_composite_key` | `parse_composite_key()` | empty, single-part, multi-part, null-delimited |

Pattern: each target creates an `instances` list of byte vectors (empty, truncated valid, random, max-size) and asserts `decode` returns `Err` for invalid inputs and round-trips for valid ones.

### 5. Crash / Power-Loss Testing

5 physical subprocess crash tests in `src/tests/power_loss.rs`:

| Boundary # | Name | What Happens | Recovery Expectation |
|------------|------|-------------|---------------------|
| 1 | `crash_before_any_write` | After commit_seq assigned, before segment write | Transaction was never committed; watermark unchanged |
| 2 | `crash_mid_stream_write` | After writing one stream, before next stream's segment | Orphan record; skipped on recovery (Option B rollback) |
| 3 | `crash_before_batcher_submit` | After all segment writes, before batcher submit | All writes durable but not indexed; replayed via segment scan |
| 4 | `crash_mid_batcher_submit` | After batcher begin, before batcher finish | Incomplete batch; recovered via segment scan |
| 5 | `crash_after_batcher_submit` | After batcher finish, before response to caller | Fully committed; transaction observed after engine restart |

Tests use subprocess isolation: `spawn_crash_child()` forks the test binary with `WABIDB_CRASH_BOUNDARY` env var. A second process opens the engine normally and verifies the recovered state.

### 6. Benchmark Testing

Benchmarks live in `benches/projection_read.rs` using `criterion`. Populate 10k records across 100 groups for 10 projection types, then measure:

- **10 `get` benchmarks**: single-record lookup by exact key
- **13 `list` benchmarks**: prefix scans with optional `include_deleted`
- **1 `compact` benchmark**: compaction of 10% deleted records

Run: `cargo bench -p wabidb -- projection_read`
