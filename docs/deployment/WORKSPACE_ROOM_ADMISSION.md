# Workspace room admission

**Status:** main Wabi working-tree candidate. This is a prerequisite for
regional room ownership; it does not route work to another node.

## Write contract

New local Wiki, Forum, incident, gallery and project-task events pass a shared
database admission check before their encrypted records are prepared. The
adapter uses the same explicit event catalog as the sequencer. It includes
all 22 event types registered by these five workspace families, including Wiki
revisions, Forum votes/solution/metadata, gallery feedback and Project runs.

The check decodes the existing full payload using the projection's decoder.
The payload's parent channel must equal the stream ID and any provided room
owner condition. These workspace writes use Event records and stream kind 6.
A placed room requires a condition; the sequencer separately requires the
condition to name its immutable local runtime ID and match the current owner
and epoch. A correct remote owner's condition does not authorize this engine.

A command cannot change placement and mutate one of these workspaces together.
Placement changes apply at their existing isolated command boundary; a later
write must observe that applied owner and epoch. If any event fails admission,
the entire command is refused before preparation. Its candidate sequence may
be burned, but it creates no commit-index entry or projection change.

## Compatibility and extension

Unplaced legacy rooms retain single-Authority compatibility for otherwise valid
unguarded writes. A supplied condition must still match their actual parent.
Use the [stopped placement backfill](ROOM_PLACEMENT_BACKFILL.md) before treating
legacy rooms as explicitly placed. Do not remove this guard or rename the
runtime node to make a remote-owner error disappear.

This admission change alters no durable record fields, postcard field order,
stream encryption or historical replay rules. Project task payloads use their
maintained dual decoder for legacy postcard and current versioned records.
The Forum vote/solution decoders are shared between admission and replay with
their original field order. Older durable events
continue through their historical projection handlers; admission applies to
new local commands. A mixed-version node that lacks these checks is not an
eligible regional writer.

For a new workspace event, extend the shared `workspace_writes` catalog and
typed parent decoder, then cover missing/unrelated conditions, malformed
payloads, stream mismatch, placement races, local success and event replay.
The catalog regression compares the currently supported workspace projections
with the actual encoded test fixtures. Other event families need their own
parent and stream rules; they must not infer ownership from a convenient label.

## Remaining boundary

This validates local room ownership admission. It does not authorize accounts,
establish node enrollment or a distributed writer lease, enforce independent
regional copies, route events, selectively deliver them or provide failover.
Other internal event families and Live/session-only work still need complete
admission. Scoped child identifiers retain their existing projection semantics;
this change does not introduce a new global object-ID registry.

See [runtime identity](NODE_RUNTIME_IDENTITY.md),
[focused evidence](../testing/ROOM_PLACEMENT_FOUNDATION_2026-09-28.md), and the
[geographic implementation gates](../plans/2026-09-26-geographic-community-nodes.md).
