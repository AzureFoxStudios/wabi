# Helper-node Phase 6 + 7 Implementation Plan — Privacy-first Revision

See also: `docs/phase-index.md` for phase-name deconfliction.

## Goal

Implement helper-node Phase 6 and Phase 7 without adding a second database, without adding an append-only surveillance/history log, and without weakening Wabi's deletion/retention model.

## Architecture

- STDB remains the only database engine.
- Helper Phase 6 is a high-trust **backup/standby** path using encrypted live-state snapshots.
- Helper Phase 7 starts as a **stateless regional gateway** that forwards traffic to the authority.
- No local STDB replica on anchors by default.
- No raw STDB data-directory copy unless proven deletion-safe.
- No append-only event log.

---

## Phase namespace warning

This document is about **helper-node scaling phases**:

- Helper Phase 6 = Warm Standby / Backup Node
- Helper Phase 7 = Regional Anchors

A prior conversation used "Phase 6" for LiveKit/SFU helper wiring. That work maps to helper Phase 4 (Media Node / Voice Offload), not this document.

---

## Helper Phase 6: Warm Standby / Backup Node

### What it is

A high-trust backup target controlled by the same operator. It receives encrypted live-state snapshots after retention/deletion has already been applied. It can be manually restored/promoted if the authority dies.

### What it is not

- Not a general helper node.
- Not a random friend's worker machine.
- Not an append-only log.
- Not an audit trail.
- Not active-active replication.
- Not automatic failover.

### Trust model

A full standby can eventually recover enough state to become authority. Therefore it must be treated as authority-adjacent:

- explicit opt-in only
- encrypted snapshot payloads
- encrypted at rest on standby
- no plaintext snapshot files left behind
- manual promotion only
- clear UI/CLI warning that standby stores recoverable server data

### Snapshot semantics

Export **current live state**, not historical logs.

Before snapshot:

1. Apply retention/deletion maintenance.
2. Export current rows from selected STDB state tables.
3. Build a snapshot manifest.
4. Encrypt payload to the standby public key.
5. Send/store encrypted payload.

Do not copy STDB internal files/WAL/commitlog. Those may contain deleted history.

### Snapshot manifest

Fields:

```json
{
  "snapshotId": "snap-...",
  "authorityNodeId": "authority-...",
  "createdAtMs": 1770000000000,
  "schemaVersion": 1,
  "snapshotKind": "live_state",
  "retentionAppliedAtMs": 1770000000000,
  "includedTables": ["state_user", "state_channel", "state_message"],
  "excludedTables": ["state_presence_lease", "state_call_signal"],
  "payloadSha256": "...",
  "encryption": {
    "version": 1,
    "algorithm": "age-or-xchacha20poly1305",
    "recipientNodeId": "node-..."
  }
}
```

### Table inclusion policy

Start conservative. Export only what is needed for restore and only from live-state tables.

Likely include:

- `state_user`
- `state_user_username`
- `state_user_handle`
- `state_user_settings`
- `state_user_meta`
- `state_user_encryption_key` (sensitive; encrypted snapshot only)
- `state_channel`
- `state_channel_member`
- `state_message` (retained/current only)
- `state_role_definition`
- `state_rbac_assignment`
- `state_ban`
- `state_mute`
- `state_deafen`
- `state_app_setting`
- media/file metadata tables that represent current live state

Likely exclude from initial snapshot:

- `state_presence_lease`
- `state_socket_lease`
- `state_call_signal`
- expired/offline transient tables
- historical payment events unless current account state requires them
- raw STDB internals

### Phase 6 tasks

1. Add explicit `NodeCapability::Standby` or `NodeCapability::Backup`.
2. Add standby metadata to node records: public encryption key, last snapshot id/time/status.
3. Add snapshot manifest structs.
4. Add snapshot table allowlist.
5. Add export routine using `StdbClient::sql_query()` against allowlisted tables.
6. Add encryption wrapper. If encryption dependency choice is unclear, stub behind a trait and fail closed until implemented.
7. Add standby receive endpoint that stores encrypted payload only.
8. Add manual import/restore endpoint guarded by admin/operator flow.
9. Add manual promotion endpoint. No automatic promotion.
10. Tests:
    - snapshot manifest serializes
    - excluded tables are excluded
    - plaintext payload is not written by receive path
    - revoked/non-standby node cannot receive snapshot

---

## Helper Phase 7: Regional Anchors

### What it is

A public regional gateway in front of the authority. Initial version forwards traffic and optionally caches static/media assets. Authority remains canonical.

### What it is not, initially

- Not a read replica.
- Not a local STDB copy.
- Not a degraded history server.
- Not an offline writer.
- Not a second authority.

### Initial anchor behavior

Authority reachable:

1. Client connects to anchor.
2. Anchor forwards read/write request to authority.
3. Authority returns canonical response.
4. Anchor streams response back to client.

Authority unreachable:

1. Writes fail quickly with clear unavailable/degraded response.
2. Reads fail quickly unless they are static assets or explicitly allowed cached media.
3. No offline writes accepted.
4. No private data cache used.

### Later opt-in cache behavior

Only after explicit design and UI toggle:

- public channel reads only
- no DMs/private channels
- no admin/payment/mod tables
- short TTL
- memory-only preferred
- disk cache encrypted if used

### Phase 7 tasks

1. Add `NodeCapability::Anchor`.
2. Add config detection: `WABI_SERVER_ROLE=anchor` and `WABI_AUTHORITY_URL`.
3. Add role-aware startup logging and health status.
4. Add minimal reverse-proxy route for API forwarding.
5. Preserve auth headers and request method/body.
6. Fail fast when authority is unreachable.
7. Add static/media cache only if scoped and safe.
8. Tests:
    - anchor forwards request to authority mock
    - anchor preserves method/path/query/body
    - authority outage returns clear degraded/unavailable response
    - no STDB client is required for anchor mode unless explicitly configured

---

## Implementation order

1. Docs and phase deconfliction.
2. Snapshot/export surface inspection.
3. Add backup/standby capability and snapshot manifest types.
4. Add table allowlist and export routine.
5. Add encryption abstraction and fail-closed implementation gate.
6. Add receive/store encrypted snapshot endpoint.
7. Add manual restore/promote stubs.
8. Add anchor capability and role config.
9. Add stateless proxy forwarding.
10. Run `cargo test -p wabi-server` and relevant frontend checks if routes surface in UI.

---

## Hard boundaries

- Shared application state lives in SpacetimeDB.
- Client-local cache lives in IndexedDB.
- No append-only application event log.
- No raw STDB data directory backup until deletion-safety is verified.
- No background plaintext dumps.
- No anchor-local STDB replica by default.
- No automatic failover.
