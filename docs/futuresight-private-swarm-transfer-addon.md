# Futuresight: Private Swarm Transfer Addon

Status: future addon / design note, not core implementation yet.

## Why this exists

Wabi's core file transfer should stay private, permissioned, resumable, and understandable. But the same chunked/hash-verified transfer foundation could later support a torrent-inspired community acceleration addon: trusted members, helper nodes, or app-dev communities can help serve large files so downloads feel faster and more resilient.

This is especially interesting if Wabi becomes useful for app/game/tool developers who document projects through Wabi wiki/forum spaces and distribute builds, assets, modpacks, datasets, examples, or documentation bundles to their communities.

The goal is not to make Wabi a public torrent client. The goal is to allow server owners to opt into private, scoped, community-assisted distribution when it makes sense.

## Core distinction

Torrent-like engineering:

- split files into chunks
- hash every chunk
- verify the whole file
- resume from missing chunks
- optionally fetch chunks from multiple sources
- show exact progress

Torrent-like public swarm behavior that Wabi core should avoid by default:

- public DHT
- public trackers
- random anonymous peers
- global content discovery
- automatic indefinite seeding
- magnet-link-first UX
- public indexing/search of files

Wabi should borrow the engineering, not the public piracy-shaped product model.

## Safe product framing

Good wording:

> Private, resumable, hash-verified transfers with optional trusted peer acceleration.

Avoid wording:

> Wabi torrents.

Wabi core should remain:

- lightweight
- private/offline-first where possible
- server-owner controlled
- explicit about storage and retention
- opt-in for advanced distribution behavior

## Possible addon names

- Private Swarm Transfer
- Community Cache Transfer
- Trusted Peer Acceleration
- Local Swarm Delivery
- Wabi Swarm Addon

## Intended users

- indie app/game developers sharing builds and assets
- modding communities distributing large modpacks
- VFX/art communities sharing packs, references, or project files
- classrooms/workshops/LAN events
- self-hosted documentation/wiki/forum communities with large attachments
- private teams that want faster local distribution without central CDN costs

## Non-goals

This addon should not become:

- a public piracy client
- a public torrent index
- a global file search engine
- an anonymous public swarm
- a default part of Wabi core
- an automatic indefinite seeding system

## Addon model

This should be an optional server-owner addon.

Server owner controls:

- whether private swarm transfer is enabled
- which channels/categories may use it
- max file size
- retention policy
- whether members may seed/cache
- whether helper nodes may cache
- whether LAN peer discovery is allowed
- whether WAN peer acceleration is allowed
- whether incentives/reputation are enabled
- legal/community rules shown to users

Users should see:

- clear opt-in/opt-out for caching/seeding
- storage used by cached chunks
- pause/resume controls
- delete local cache button
- what communities/files they are helping serve

## Architecture idea

Core Wabi transfer manifest:

```json
{
  "transferId": "transfer-...",
  "blobId": "blake3-or-sha256-...",
  "fileName": "example.zip",
  "fileSize": 123456789,
  "mime": "application/zip",
  "chunkSize": 4194304,
  "chunkCount": 30,
  "wholeHash": "...",
  "chunkHashes": ["..."],
  "allowedRecipients": ["user-1", "role-devs"],
  "allowedSources": ["server", "helper-node", "trusted-peer"],
  "retention": {
    "server": "30d",
    "peerCache": "7d"
  }
}
```

Transport plugins can use the same manifest:

- HTTP chunk upload/download
- WebRTC DataChannel
- server relay
- helper node relay
- LAN trusted peer cache
- rsync/parsyncfp admin sync
- future private BitTorrent-like transport

The important abstraction:

> Wabi moves verified chunks. The transport is replaceable.

## Private swarm behavior

A private swarm source should only serve chunks when:

- the file manifest is known to the server
- the requesting user is authorized
- the serving peer opted into caching/seeding
- the transfer belongs to a specific Wabi server/community
- the chunk hash matches the manifest

A private swarm source should not serve arbitrary files from disk.

## Discovery options

Safe discovery options:

1. Server-mediated source list
   - receiver asks Wabi server for eligible sources
   - server returns helper nodes/trusted peers that opted in
   - simplest and safest

2. LAN-only discovery
   - mDNS/local discovery for same-network peers
   - still requires server-issued authorization token
   - useful for LAN parties, classrooms, studios

3. Private tracker-like service
   - server acts as private tracker for one community
   - no public DHT
   - no public tracker
   - no peer exchange beyond authorized scope

Avoid by default:

- public DHT
- public trackers
- unauthenticated peer exchange

## Incentives / reputation ideas

This can be explored later, but should stay optional.

Possible soft incentives:

- community badge: "helped serve 12 GB this month"
- contribution meter per server
- priority downloads for active cache contributors
- role perks controlled by server owner
- storage quota rewards
- opt-in community gratitude/reputation

Avoid turning Wabi core into a financial/marketplace system for seeding unless a separate legal/product review happens.

## Legal / moderation posture

Not legal advice, but practical safety rules:

Low-risk posture:

- private community transfers
- no public index
- no global search
- no public swarm by default
- no automatic seeding to strangers
- server-owner moderation and retention controls
- clear user/admin responsibility docs

Higher-risk posture to avoid in core:

- public torrent indexing
- public magnet-link sharing as a headline feature
- anonymous global swarms
- facilitating arbitrary copyrighted content distribution
- ignoring takedown/moderation controls for public communities

Recommended disclaimer direction:

> Wabi provides private transfer infrastructure. Server operators and users are responsible for ensuring they have rights to share content through their communities.

## Verbose progress UI requirement

This addon must not use vague frozen spinners.

Required user-visible transfer state:

- file name
- total size
- transferred bytes
- percentage
- completed chunks / total chunks
- current phase:
  - preparing
  - hashing
  - requesting sources
  - transferring
  - paused
  - resuming
  - verifying
  - complete
  - failed
- current speed
- source count, if multi-source
- retry count or stalled source indicator
- pause/resume/cancel controls
- retry button on failure

Example copy:

- `Preparing 2,048 chunks...`
- `Transferring 344 / 2,048 chunks · 1.4 GB / 8.2 GB · 42 MB/s`
- `Paused — 344 chunks saved`
- `Resuming — verifying saved chunks...`
- `Verifying file hash...`
- `Complete — hash verified`

Acceptance rule:

> If the user cannot tell whether a transfer is progressing, paused, verifying, stalled, or failed, the transfer UI is not done.

## Relationship to parsyncfp / rsync

parsyncfp/rsync are good for admin/server/helper-node sync:

- moving Wabi media/blob libraries
- backups
- helper node replication
- weak remote deploy/sync flows

They are not ideal as browser-level P2P transfer primitives.

Use them as optional backend/admin transport adapters, not as the core in-app transfer protocol.

## Future implementation phases

Phase 0: audit current P2P/file-transfer code.

- event matrix
- frontend emit/listen
- backend emit/listen
- byte path
- pause support
- resume support
- hash verification
- storage/persistence
- progress UI

Phase 1: core resumable transfer manifest.

- chunk manifest
- progress state
- pause/resume/cancel events
- hash verification
- verbose progress UI

Phase 2: server-relayed chunks.

- upload chunks
- download missing chunks
- resume after disconnect
- server storage quota/cleanup

Phase 3: WebRTC DataChannel direct transfer.

- direct peer chunks
- fallback to server relay
- progress from real bytes/chunks

Phase 4: helper-node/local peer acceleration.

- trusted source list
- LAN discovery optional
- cache controls

Phase 5: private swarm addon.

- opt-in peer cache
- server-mediated source discovery
- optional incentives/reputation
- admin controls and disclaimers

## Decision for now

Document and defer. This is promising as an addon, especially for developer/wiki/forum communities, but it is not critical for the current backend verification pass.

For the current pass, focus on proving/fixing basic P2P transfer signaling, resumable transfer foundations, and verbose progress UI requirements.
