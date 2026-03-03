# Wabi State Bridge Module (SpacetimeDB)

This module provides a migration bridge reducer:

- `ingest_wabi_event(event_json: String)`

It ingests Wabi state-plane outbox envelopes, stores an idempotent event log (`ingested_event`), and projects a minimal core read model into tables:

- `state_message`
- `state_channel`
- `state_channel_member`
- `state_user`
- `state_session`
- `state_rbac_assignment`

## Prerequisites

- SpacetimeDB CLI `2.0.2`
- Rust toolchain `1.93.0+` (required by `spacetimedb = 2.0.2`)

## Build/Publish

From this directory:

```bash
spacetime publish --project-path .
```

Or target a specific database name/server:

```bash
spacetime publish --project-path . --server local <database_name>
```

## Wabi Integration

Set command sink to call bridge script:

```bash
STATE_SHADOW_SINK=command
STATE_SHADOW_COMMAND=node scripts/state-plane-stdb-bridge.mjs --mode spacetime-call --server local --database <database_name> --reducer ingest_wabi_event --no-config --anonymous --yes
STATE_SHADOW_COMMAND_TIMEOUT_MS=10000
```

Optional mapping file:

```bash
STATE_SHADOW_COMMAND=node scripts/state-plane-stdb-bridge.mjs --mode spacetime-call --server local --database <database_name> --map-file scripts/state-plane-stdb-bridge-map.example.json --no-config --anonymous --yes
```

Preflight check:

```bash
node scripts/state-plane-bridge-check.mjs --json
```
