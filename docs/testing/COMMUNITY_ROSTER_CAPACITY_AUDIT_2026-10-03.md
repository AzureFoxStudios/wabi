# Community roster capacity audit — October 3, 2026

Read-only source analysis of main Wabi on dotRonin, root revision
`0b82cec796061d274b22655d16f24ca29720c7c3` plus the recorded working-tree
hashes in [the audit receipt](geographic-2026-10-02/community-roster-capacity-audit1.json).
No load benchmark, network trace or capacity acceptance was performed.

## Observed implementation

- `socketio/presence.rs::server_members_snapshot` obtains every projected user,
  constructs role/media/badge views through `join_all`, and caches the full
  `Vec<Value>`. Every cache hit clones that full vector. Cache reuse requires
  the same roster revision and an age below 30 seconds; caching reduces repeated
  view construction but does not bound per-connection output or cloning.
- `on_join` constructs views for every connected socket while holding the
  connected-users read lock. Its `init` includes both `users` and the complete
  `serverMembers`; arrivals are broadcast to all other connected sockets.
- `WdbAdapter::list_users` passes `UsersFilter::default()`. Without an exact
  user ID, `UsersProjection::query` traverses, decodes and collects all matching
  records before applying its optional limit. Adding a result limit alone does
  not bound this read's scan/materialization cost.
- The frontend normalizes/stores the full member list. DM search filters and
  sorts a directory built from that list; the Office recipient selector renders
  an option for every member with a database ID. Partial loading must preserve
  identity lookup, existing recipients and accurate role/access decisions.

## Consequences inferred from source

Let `N` be registered users, `C` connected sockets, `B` the mean encoded member
view bytes and `J` joins/reconnects per second. Full-directory join output alone
is approximately `N × B` bytes per join and `J × N × B` bytes/second, before
online presence, channels, protocol/TLS overhead and compression. Arrival
fanout grows with `C`. Online construction is socket-based, so multiple devices
for one account also contribute. Actual heap cost exceeds encoded byte length.

For illustration only, `N=500,000`, `B=400` gives **200 MB per join**;
ten joins/second gives **2 GB/second** of uncompressed directory output. The
400-byte assumption is not a measurement; bios, badges and profile metadata
change it. This does not estimate the overall capacity of a finished design.
An Anchor forwarding this initialization does not remove its Authority cost.
Media SFUs solve a separate media distribution workload.

## Required design and acceptance work

1. Provide bounded cursor reads and exact identity lookups through storage,
   adapter and authenticated API. Define searchable-directory indexing and
   continuation semantics without scanning all users for each page.
2. Bound initialization: explicit self/session identity, requested room
   participants and a limited presence page. Subscribe to relevant presence
   with permission-aware invalidation; never silently treat omitted members as
   absent or unauthorized.
3. Update People, DM/group pickers and Office sharing to search/page on demand,
   with loading/error states, unresolved-ID handling and existing grants kept
   visible. Coordinate the shared frontend owners before changing these files.
4. Add regressions for bounded reads/output, reconnect, multiple devices,
   permission changes and partial-directory UI. Then measure cold/warm joins,
   reconnect bursts, RSS, CPU, network bytes and queue/backpressure using real
   storage, server and clients at the registered/concurrent populations chosen
   in the master plan. Record packet limits by transport empirically; no
   inbound configuration default is assumed to cap outbound initialization.

Independent regional room ownership/selective delivery, full-instance recovery
and measured hot-room capacity remain separate unfinished gates in the
[master plan](../plans/2026-09-26-geographic-community-nodes.md).
