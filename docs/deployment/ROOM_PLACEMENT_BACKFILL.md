# Legacy room placement backfill

**Status:** candidate stopped-Authority migration for main Wabi. It assigns existing active rooms and retained direct-call scopes to the **same** Authority node. It does not move a room, add another writer, or make failover safe.

New channels, private conversations and standalone direct calls write a local placement during creation. Older unplaced scopes continue under the single Authority. `wabi-room-placement-backfill` adds an epoch-one placement for them in bounded batches.

The tool enumerates active Channel records and canonical direct-call scopes in
the retained call-session projection. It includes ended direct calls because
their deterministic session ID can be reused. Calls attached to Channels use
that Channel's placement. A direct scope such as `dm:user-1:user-2` uses the
reserved placement ID `call-dm-user-1-user-2`; its stored/public scope stays
unchanged, and no DM chat Channel is created. Account names retain their existing
lexicographic order (`user-10` precedes `user-2`). A direct call's placement is
separate from any DM chat between those accounts. Live media admission and a
complete distributed room-write fence remain open. See the
[coverage and limits](../testing/ROOM_PLACEMENT_FOUNDATION_2026-09-28.md#boundary).

## Before running

1. Choose the stable `WABI_NODE_ID` that this Authority will use. The default is `node-1`. Keep it the same on every restart. If existing placements have another owner, the tool refuses the directory; inspect the configuration and restore the original ID instead of rewriting events.

   The tool selects this ID at engine open, sharing it with its sequencer;
   a running adapter can no longer change its engine identity. See the
   [runtime identity contract](NODE_RUNTIME_IDENTITY.md).
2. Stop the Authority and any other process that could open its WabiDB directory. The tool opens WabiDB with its exclusive engine lock **even for preview**, and opening may perform normal engine recovery or write derived state.
3. Make a complete, verified stopped-instance backup of the Authority data tree and any external uploads, secrets, plugin state and other configured paths. Follow [Backup and Recovery](BACKUP_AND_RECOVERY.md). Preserve this pre-migration copy for rollback; an older binary may not understand the placement events.
4. Build the tool from the same Wabi revision as the Authority with `cargo build --locked --release -p wabi-server --bin wabi-room-placement-backfill`. Supply the actual Authority data directory, the parent of `wabidb/`. If the root key comes from `WABIDB_ROOT_KEY`, provide that same secret to the tool through the usual protected environment.

## Preview and apply

With the Authority stopped, preview one batch:

```bash
./target/release/wabi-room-placement-backfill \
  --data-dir /path/to/wabi-server-data \
  --node-id site-a \
  --limit 100
```

After checking the chosen node ID and the backup, apply the batch:

```bash
./target/release/wabi-room-placement-backfill \
  --data-dir /path/to/wabi-server-data \
  --node-id site-a \
  --limit 100 \
  --apply
```

`activeRooms` still counts visible active Channel records. `directCallScopes`
counts distinct retained direct-call placements, and `placementScopes` counts
the combined distinct room/call placements under inspection. `alreadyPlaced`,
`selected`, `remaining` and `complete` now cover that combined set. `selected`
is capped by `--limit` (1–1000). In preview, `remaining` counts all unplaced
scopes; after an apply, it counts those left after that batch. Repeat `--apply`
with the **same node ID** until `complete` is true. Repeating a completed run
adds no events. Keep the Authority stopped for the whole sequence, then start
it with `WABI_NODE_ID` set to that ID.

The tool refuses missing or symlinked WabiDB identity files, a scope already
placed on a different node, malformed/rebound direct-call scopes, mismatched
call-session keys, collisions with Channel records (including inactive records),
and applying to a fenced or activation-pending Authority. Validation covers the
whole collected set before any placement batch is committed. It does not
inspect every optional sidecar or external integration. Its placement events
are local migration history, not a cross-node agreement or proof that another
node has the room data.

See the [focused migration check](../testing/ROOM_PLACEMENT_FOUNDATION_2026-09-28.md) and the [geographic community web plan](../plans/2026-09-26-geographic-community-nodes.md) for the remaining ownership and recovery gates.
