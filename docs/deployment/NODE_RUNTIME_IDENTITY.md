# Authority runtime node identity

**Status:** current main Wabi worktree candidate. This fixes local write
admission; regional owner routing and automatic failover remain unfinished.

## Select identity before startup

`WABI_NODE_ID` is the Authority's operator-selected logical node ID. The default
is `node-1`. IDs contain 1–64 ASCII letters, digits, hyphens or underscores and
begin with a letter or digit. Keep the ID stable across restarts and preserve
it with the protected operator configuration in an instance backup.

The Authority now passes this ID when opening WabiDB, before storage mutation,
replay or worker startup. The engine and sequencer retain the same immutable
runtime value. The adapter reads the engine's value rather than holding a
separately mutable copy. Server and engine validation use the same rules.
Invalid IDs refuse Authority state construction before opening file-backed
sidecars, and refuse engine opening before creating its directory; the adapter's
path opener checks before resolving or creating a root key.

For programmatic embedding:

- `WabiDbEngine::open(config)` retains the `node-1` default.
- `WabiDbEngine::open_with_node_id(config, id)` selects a custom identity.
- `WdbAdapter::open_with_node_id(path, id)` resolves the normal bootstrap key
  and selects identity before opening.
- `WdbAdapter::open_with_config_and_node_id(config, id)` supports explicit
  bootstrap/replication/passphrase configurations with that identity.
- `with_local_node_id(id)` is now only a compatibility assertion. It accepts
  the already-selected ID and refuses attempts to rename a running engine.
  Replace an old custom-ID builder call with an identity-aware opener.

## Admission behavior

Every provided room owner condition must name this engine's local ID, as well
as match the current placement's owner and epoch. Supplying a remote room's
correct owner and epoch no longer lets a caller impersonate that remote owner
on this engine. An unplaced condition naming another node is also refused.
Rejection precedes durable event preparation and leaves the applied position
and commit index unchanged.

Existing mandatory-parent checks still apply to persisted call and selected
message/reaction paths. Missing conditions on other, not-yet-guarded event
types remain outside this change. Unplaced legacy message rooms retain their
single-Authority compatibility path. An identity check is not a substitute for
membership authorization, complete live/session admission or room routing.

Placement control events can still record another owner as intent. Replay can
also load placements owned by other nodes. Neither grants the local sequencer
that node's write identity. No postcard/event encoding or historical replay
rule changes are required, and no new identity file is written to WabiDB.

## Restore and remaining trust boundary

Runtime identity is selected anew from operator configuration on each restart;
it is not a certificate or a durable node enrollment record. For a controlled
whole-Authority restore, retain the logical ID matching its existing rooms and
follow the [stopped recovery/fencing procedure](BACKUP_AND_RECOVERY.md).
Changing the ID to move room ownership is not a supported handoff: existing
placements will refuse local writes until a real handoff protocol exists.

An operator who controls binaries, configuration and root keys can still copy
an instance or run another process with the same logical ID. Preventing two
writable copies across hosts requires authenticated node membership, a
distributed lease/quorum and fencing. This change establishes none of those
properties. It does not pass geographic Gates B, C or D. See the
[geographic plan](../plans/2026-09-26-geographic-community-nodes.md) and
[room-admission evidence](../testing/ROOM_PLACEMENT_FOUNDATION_2026-09-28.md).
