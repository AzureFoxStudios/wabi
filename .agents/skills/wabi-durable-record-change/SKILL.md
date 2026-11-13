---
name: wabi-durable-record-change
description: Use before adding, removing or reordering a field on any record WabiDB persists (postcard records, event payloads, projection rows).
---

# Changing a durable WabiDB record

AGENTS.md golden rule 5: postcard-encoded persistent records need a
compatibility plan. Adding, removing or reordering a field without a versioned
decoder can make stored data unreadable on replay. The mechanism is
`wabidb::format::versioned` (`core/crates/wabidb/src/format/versioned.rs`),
specified in `docs/architecture/STORAGE_FORMAT.md` §7.1.

**Stop and ask the owner if you are unsure whether stored data stays
readable.** Breaking replay can destroy access to real data.

## Is the type durable?

Durable (this skill applies) if any of these hold:

- it has a `RecordFormat::new(*b"TAG", …)` / implements `RecordCodec`
  (`projections/codec.rs`), or appears in
  `tests::golden_records::every_durable_record_is_versioned`
  (`src/tests/golden_records.rs`);
- its bytes go into an event payload committed through the engine (a
  `run`/`run_room` call in the server's `WdbAdapter`), or into a projection row
  in `snapshot.json` or `projections/read-model.sqlite3`;
- it is one of the four versioned event payloads that are not rows (`FVOT`,
  `FSOL`, `UDEL`, `DOTP`, STORAGE_FORMAT.md §7.1).

JSON event payloads and the JSON sidecar files in the data directory
(`docs/deployment/BACKUP_AND_RECOVERY.md` lists them) are persisted too; they
are not on this helper, so keep old files and payloads decodable and test with
an old one.

Usually transient: request/response bodies, `crates/wabi-core` view types
(`UserView`, `ChannelView`, …; generated into `packages/wabi-protocol`, golden
rule 4), in-memory caches. Grep that the type is not also written to disk
before treating it as transient.

## Checklist (STORAGE_FORMAT.md §7.1)

1. **Capture golden bytes from the current encoder first**, before touching
   the struct. Each converted type has a `tests::golden_records::golden_*`
   test holding the exact legacy bytes as hex (e.g. `CHANNEL_MEMBER_LEGACY`);
   `converted(…)` asserts legacy bytes decode and that the version-1 payload
   equals them ("payload layout changed"). A type without a golden test gets
   one now.
2. **Type not on the helper yet?** If it is missing from
   `every_durable_record_is_versioned`, convert it to `format::versioned`
   (version 1 = today's layout, legacy raw postcard still decodes), with
   golden bytes captured first, before changing any field (AGENTS.md rule 5).
3. **Keep the old layout as its own struct** (e.g. `FooV1`), unchanged.
4. **Bump the version**: write with `versioned::encode(&FORMAT, 2, &value)`.
5. **Keep a decoder for every version ever written**: `versioned::decode`
   with a match on the version (`1 => payload::<FooV1>(…).map(Foo::from)`,
   `2 => payload::<Foo>(…)`) plus the legacy raw-postcard fallback. Pattern:
   `format::versioned::tests::older_version_dispatches_to_its_own_decoder`.
6. **Read model**: a new record version changes stored rows, so bump
   `READ_MODEL_GENERATION` in `projections/read_model/schema.rs` in the same
   change (see the `wabi-read-model-projection` skill).
7. **Offline inspection** treats legacy and version-1 bytes as equal only for
   version 1. After a bump, a projection saved before it will not match a
   replay; rebuilding saved projections on a version change is *planned*, not
   done (§7.1). Say so in the PR.
8. **Docs**: update STORAGE_FORMAT.md §7.1 (it states "No record type has a
   version 2 yet"; change that when it stops being true) and the relevant
   engine doc in the same PR.

The change is one-way: a build from before a version cannot read records
written with it. Roll back only with a matching stopped backup
(`docs/deployment/BACKUP_AND_RECOVERY.md`).

## Tests to keep passing

```bash
cargo test -p wabidb --lib golden_records
cargo test -p wabidb --lib pre_versioning_fixture
cargo test -p wabidb --lib format::versioned
```

- `tests::pre_versioning_fixture::*` opens the committed data directory in
  `core/crates/wabidb/tests/fixtures/pre_versioning_records/` (a real
  pre-versioning snapshot and log): `pre_versioning_snapshot_still_decodes`,
  `pre_versioning_log_replays_to_the_same_state`,
  `pre_versioning_log_with_new_writes_replays`, and the offline-inspection
  tests. Never regenerate that fixture to make a test pass: it is the evidence
  that old data still opens.
- `tests::golden_records::record_codec_never_writes_unversioned_bytes` and
  `every_durable_record_is_versioned`.
- Add: a golden test for the new version's bytes, and a test that version-1
  bytes decode into the new type.
