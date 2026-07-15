# What We've Done

## 1. Tombstone Compaction (#5)
- Added `remove` and `compact_index` methods to `ProjectionState` in `engine/locks.rs`
- Updated all 6 projections with `is_deleted` field:
  - **messages**, **wiki**, **forum**, **incidents**, **albums**, **album_items**
  - `list_*` methods accept `include_deleted: bool`, filter by default
  - Added `compact()` static method to each
- 19 new tests (743 total)
- Made `encode_key` pub in `channel_members.rs`

## 2. Performance Benchmarking (#3)
- Created `benches/projection_read.rs` — 10 `get`, 13 `list`, 1 `compact` benchmark
- Added `[[bench]]` to Cargo.toml
- Runs on 10k records across 100 groups

## 3. Wire Albums → wabi-server (#1)
- Added `Album` and `AlbumItem` domain types to `wabidb/src/domain/mod.rs`
- Added `list_albums`, `get_album`, `create_album`, `delete_album`, `list_items`, `add_item`, `delete_item` to `WabiStore` trait
- Implemented in `WdbAdapter` (reads from projections, writes events)
- Added default stubs in `LocalWabiStore`
- Rewrote `wabi-server/src/api/albums.rs` to use `state.wdb`

## 4. wabi-server Compilation Fixes
- Fixed `decode_record` calls returning `Result` (not `Option`) — 8 occurrences
- Fixed `encode_reaction` returning `Vec<u8>` (not `Result`) — 2 occurrences
- Added missing `ChannelKind` variants (Wiki, Forum, Incident)
- Fixed `await` inside non-async closure in `list_albums`
- Removed unused imports (`AlbumRecord`, `AlbumItemRecord`)
- **Status: wabidb tests pass (743), wabi-server compiles with only minor dead-code warnings**
