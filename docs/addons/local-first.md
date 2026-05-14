# Local-First Storage

Wabi stores data on users' devices by default.

## Storage Tiers

| Tier | Location | Default | Sync |
|------|----------|---------|------|
| **Local** | IndexedDB | On | P2P via CRDT |
| **Server-cache** | Server RAM | Off | Volatile |
| **Server-archival** | Server SSD | Off (opt-in) | Persistent |

## Default Behavior

- All messages, channels, settings → user's device
- Server knows only user accounts + channel definitions
- User has full chat history locally

## How It Works

```
User sends message:
1. Store in local IndexedDB (immediate, offline)
2. Broadcast via WebSocket to server
3. Server broadcasts to other online users
4. Other users store in their local IndexedDB

Offline? Message queued, synced when online.
```

## Server Storage (Optional)

Enable `server-auditor` addon for:

- Message history that survives server restarts
- Compliance archival
- History for users who rejoin

## User Control

- Export all data via Settings → Export
- Delete local data clears IndexedDB
- Server-archival only if auditor enabled

## Data Flow

```
┌─────────┐     ┌─────────┐     ┌─────────┐
│  User   │────▶│ Server  │────▶│  Peer   │
│ (local) │     │ (cache) │     │ (local) │
└─────────┘     └─────────┘     └─────────┘
    ▲                                    │
    └────────────────────────────────────┘
         P2P sync (when server offline)
```

See `ADDON_ARCHITECTURE.md` for technical details.