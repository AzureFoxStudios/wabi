# Message ID lookup — current worktree candidate

The Authority adapter resolves a message ID through an SQL index on the
`messages` table of the SQLite read model (`projections/read-model.sqlite3`),
not by decoding all retained messages. Durable message/event encodings and
normal room history are unchanged. (Before Task 3.5 this was an in-memory index
named `message_by_id_v1`; errors still use that name as their location.)

## No startup migration

The index is part of the table it indexes, so it cannot miss an entry or point
at a row that is gone, and startup neither rebuilds nor validates it. A read
model written by another build, or a damaged one, is replaced and rebuilt from
the log as a whole (tests:
`tests::read_model_messages::a_read_model_of_another_generation_is_rebuilt_from_the_log`,
`tests::read_model_messages::a_damaged_read_model_is_rebuilt_from_a_whole_log_and_kept_when_the_log_is_short`).
A snapshot saved by an older build still lists the old index; it is not loaded
(test: `engine::message_admission_tests::open_ignores_legacy_snapshot_message_indexes_and_rebuilds_from_the_log`).
The first start of this build on an existing installation replays the whole
log; see [Version compatibility](BACKUP_AND_RECOVERY.md#version-compatibility).
This has not been deployed or migrated on a live community.

## Duplicate records

Older data may contain the same message ID in multiple rooms. All those rows
are kept. Room-scoped history can still distinguish them; an ID-only read or
new mutation reports an ambiguity error instead of selecting an arbitrary room
(tests: `projections::message_lookup::tests::legacy_duplicate_ids_preserve_both_rooms_but_fail_id_only_resolution`,
`tests::read_model_messages::the_same_message_id_in_two_rooms_reads_the_same_after_the_file_is_reopened`).
Nothing renames or merges IDs.

## Write and retention behavior

New local message create/edit/delete, channel clear and reaction events check
their actual parent and expected event stream before durability. A placed room
requires its matching owner/epoch condition. A different room's valid condition
does not grant admission. An unplaced room keeps single-Authority compatibility.
Missing-parent reactions and attempts to move an existing ID into another room
are refused. Placement changes and message mutations use separate commands.

Soft deletion still retains the message's row until compaction. Compaction
removes the row and every version row, including earlier live versions, so a
history query cannot resurrect that message (test:
`projections::message_lookup::tests::lookup_tracks_edits_and_deletion_and_compacts_all_time_versions`).
Nothing in the server runs compaction, and it is not an event: a read model
rebuilt from the log holds the compacted rows again (test:
`tests::read_model_messages::deleting_the_read_model_file_changes_no_read`).
This does not erase historical segment bytes or backups.

The condition remains trusted application data. The engine now also requires
its owner to equal the immutable [local runtime identity](NODE_RUNTIME_IDENTITY.md).
That operator-selected value is not authenticated node enrollment or a
distributed lease. Live media/session admission, regional
owner routing, room handoff and per-room failover remain open. See the
[focused evidence](../testing/ROOM_PLACEMENT_FOUNDATION_2026-09-28.md) and
[geographic plan](../plans/2026-09-26-geographic-community-nodes.md).
