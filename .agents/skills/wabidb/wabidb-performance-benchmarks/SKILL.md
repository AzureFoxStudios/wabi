---
name: wabidb-performance-benchmarks
description: "Learn WabiDB's benchmark suite — 24 criterion benchmarks measuring projection read performance across get, list, and compact operations on 10k records."
---

# WabiDB Performance Benchmarks

This skill covers WabiDB's Criterion-based benchmark suite in `benches/projection_read.rs`, which measures the read throughput of all major projection query methods.

## When to Use

- Measuring the performance impact of changes to projection query methods
- Regression-testing read latency after adding new projection features
- Understanding the baseline performance characteristics of projection reads

## Prerequisites

- Access to WabiDB source code at `/var/home/Ronin/wabi`
- Rust toolchain with nightly (for `cargo bench`)

## How to Run

```bash
# Run all benchmarks
cargo bench -p wabidb

# Run only projection benchmarks
cargo bench -p wabidb -- projection_read

# Run a specific benchmark group
cargo bench -p wabidb -- "projection_get/"

# Run a single benchmark
cargo bench -p wabidb -- "projection_get/get_message"
```

## Key File

`benches/projection_read.rs` (381 lines) — the entire benchmark suite.

## Dataset

The `populate()` function creates **10k records** across **100 groups** (100 records per group) for each of 10 projection types:

| Projection | Index Name | Records |
|------------|-----------|---------|
| messages | messages | 10,000 |
| channel_members | channel_members | 10,000 |
| dm_messages | dm_messages | 10,000 |
| dm_message_recipients | dm_message_recipients | 30,000 (3 recipients per msg) |
| reactions | reactions | 500 (5 emoji reactions on first msg per group) |
| wiki_pages | wiki_pages | 10,000 |
| forum_posts | forum_posts | 10,000 |
| incidents | incidents | 10,000 |
| albums | albums | 100 (1 per group) |
| album_items | album_items | 10,000 |

Approximately 10% of records are marked `is_deleted = true` for compaction benchmarks.

## Benchmark Groups

### `projection_get` (10 benchmarks)

Measures single-record lookup by exact key:

| Benchmark | Method | Key |
|-----------|--------|-----|
| `get_message` | `MessagesProjection::get_message()` | channel_id + message_id |
| `get_member` | `ChannelMembersProjection::get_member()` | channel_id + user_id |
| `get_dm_message` | `DmMessagesProjection::get_message()` | dm_id + message_id |
| `get_recipient` | `DmMessageRecipientsProjection::get_recipient()` | dm_id + message_id + user_id |
| `get_reaction` | `ReactionsProjection::get_reaction()` | message_id + user_id + emoji |
| `get_page` | `WikiProjection::get_page()` | channel_id + page_id |
| `get_post` | `ForumProjection::get_post()` | channel_id + thread_id + post_id |
| `get_incident` | `IncidentProjection::get_incident()` | channel_id + incident_id |
| `get_album` | `AlbumProjection::get_album()` | scope_type + scope_id + album_id |
| `get_album_item` | `AlbumItemsProjection::get_item()` | album_id + item_id |

### `projection_list` (13 benchmarks)

Measures range scans with prefix lookup:

| Benchmark | Method | Notes |
|-----------|--------|-------|
| `list_messages` | `list_messages(ch, false)` | Excludes deleted |
| `list_messages_include_deleted` | `list_messages(ch, true)` | Includes deleted |
| `list_members` | `list_members(ch)` | All members in channel |
| `list_dm_messages` | `list_messages(dm_id)` | All DMs in conversation |
| `list_recipients` | `list_recipients(dm_id, msg_id)` | All recipients of a DM |
| `list_reactions` | `list_reactions(msg_id)` | All reactions on a message |
| `list_pages` | `list_pages(ch, false)` | Wiki pages excluding deleted |
| `list_posts` | `list_posts(ch, thread, false)` | Forum posts in thread |
| `list_threads` | `list_threads(ch, false)` | Thread starters in channel |
| `list_incidents` | `list_incidents(ch, false)` | Incidents excluding deleted |
| `list_albums` | `list_albums(scope_type, scope_id, false)` | Albums in scope |
| `list_album_items` | `list_items(album_id, false)` | Items in album |

### `projection_compact` (1 benchmark)

| Benchmark | Method | Effect |
|-----------|--------|--------|
| `compact_messages` | `MessagesProjection::compact()` | Removes ~1000 deleted records |

## Configuration

```rust
criterion_group! {
    name = projection_read;
    config = Criterion::default().sample_size(20).measurement_time(Duration::from_secs(3));
    targets = bench_get, bench_list, bench_compact
}
```

- 20 samples per benchmark
- 3-second measurement time
- Each benchmark uses `black_box()` to prevent compiler optimizations

## Adding a New Benchmark

1. Import the projection module at the top of the file
2. Add data to the `populate()` function
3. Add a `bench_*` function or extend an existing one
4. Register in the `criterion_group!` macro
