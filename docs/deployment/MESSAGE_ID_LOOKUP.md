# Message ID lookup — current worktree candidate

The Authority adapter now resolves a message ID through `message_by_id_v1`
instead of decoding all retained messages for each request. The derived index
stores a pointer to the existing room-scoped primary record, not another body.
Durable message/event encodings and normal room history are unchanged.

## Startup migration

No separate apply command is required. Before serving requests, engine startup
validates every primary message row and existing lookup pointer, then inserts
missing pointers and saves the snapshot if anything was rebuilt. It preserves
the applied commit watermark. Older committed events populate the lookup
through the normal replay handlers.

Startup therefore scans retained history and temporarily holds expected
pointers in memory. Allow restart time and memory for that work; no
large-community startup benchmark is established. Use the normal
[backup procedure](BACKUP_AND_RECOVERY.md) before changing an existing
installation's binary. This candidate has not been deployed or migrated on a
live community.

Use a consistent binary version across any experimental source/receiver pair.
An older binary does not maintain this index, including its compaction cleanup;
do not treat a downgrade as a tested migration/recovery path. Keep a complete
pre-upgrade backup for any separately controlled rollback.

## Duplicate and damaged records

Older data may contain the same message ID in multiple rooms. Migration keeps
all those primary rows and pointers. Room-scoped history can still distinguish
them; an ID-only read or new mutation reports an ambiguity error instead of
selecting an arbitrary room. This migration does not rename or merge IDs.

Malformed primary records, mismatched primary keys or conflicting existing
pointers refuse engine startup before the dispatcher and sequencer start.
Existing pointers are checked before any missing pointer is inserted. Preserve
the stopped instance and investigate a disposable copy using the recovery
guide. Restore/replay must be verified against the committed log; there is no
automatic destructive repair or empty-index fallback.

## Write and retention behavior

New local message create/edit/delete, channel clear and reaction events check
their actual parent and expected event stream before durability. A placed room
requires its matching owner/epoch condition. A different room's valid condition
does not grant admission. An unplaced room keeps single-Authority compatibility.
Missing-parent reactions and attempts to move an existing ID into another room
are refused. Placement changes and message mutations use separate commands.

Soft deletion still retains the primary tombstone until compaction. Compaction
removes its ID pointer and every time-index version, including earlier live
versions, so a history query cannot resurrect that message from a secondary
index. This does not erase historical segment bytes or backups.

The condition remains trusted application data. The engine now also requires
its owner to equal the immutable [local runtime identity](NODE_RUNTIME_IDENTITY.md).
That operator-selected value is not authenticated node enrollment or a
distributed lease. Live media/session admission, regional
owner routing, room handoff and per-room failover remain open. See the
[focused evidence](../testing/ROOM_PLACEMENT_FOUNDATION_2026-09-28.md) and
[geographic plan](../plans/2026-09-26-geographic-community-nodes.md).
