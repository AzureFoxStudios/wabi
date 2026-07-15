# Wabi Private Swarm / Community Seeding Add-on Proposal

## Summary

Wabi should not frame its file system as “public torrenting” in core. The durable version is a private, permissioned, hash-verified, resumable, multi-source transfer layer in core, with an optional add-on that lets trusted users or helper nodes seed approved files for a server/community.

Core Wabi should provide:

- transfer manifests
- chunked upload/download
- pause/resume
- per-chunk hashes
- whole-file verification
- storage and retention policy
- clear progress UI

The optional add-on should provide:

- server-scoped community seeding
- helper-node blob caching
- trusted peer source lists
- signed access tokens
- seeding opt-in controls
- bandwidth/storage caps
- admin moderation and purge controls

The goal is to borrow the good engineering of torrents — chunks, manifests, hashes, retries, multi-source delivery, community preservation — without adopting public DHT, global search, anonymous swarms, or automatic indefinite seeding.

## Recommended product framing

User-facing names:

- Community File Seeding
- Help Preserve This File
- Community Cache
- Preserved by Trusted Members

Developer/admin names:

- Private Swarm
- Server-Scoped Swarm
- Helper Node Blob Cache

Avoid marketing it as:

- Wabi torrents
- global file sharing
- anonymous swarm
- uncensorable file network
- public tracker

## Why this fits Wabi

This aligns with Wabi’s goals:

- self-hosting
- large files
- resumable transfers
- offline/local capability
- helper nodes
- privacy-first defaults
- server-owner control
- add-ons instead of core bloat
- community-owned infrastructure

A weak self-hosted server should not need to personally serve every byte forever. Trusted users and helper nodes can help preserve important files: releases, mods, builds, media packs, art packs, project archives, wiki assets, and documentation bundles.

## Core vs add-on boundary

### Core: transfer manifest

Every large file should be represented by a transport-agnostic manifest:

- file ID / blob ID
- filename
- MIME type
- total size
- chunk size
- chunk count
- per-chunk hashes
- whole-file hash
- uploader
- channel/server permissions
- retention policy
- cache policy
- optional encryption metadata
- manifest signature

The manifest should not imply swarm behavior. It just gives Wabi a durable file contract.

### Core: chunked resumable transfer

Core should support:

- chunked uploads
- chunked downloads
- pause/resume
- retry missing chunks
- verify chunks as they arrive
- verify final file
- avoid redownloading completed chunks
- detailed progress UI

This is needed anyway if Wabi supports very large files.

### Optional add-on: private swarm

The add-on lets authorized seeders/helper nodes serve chunks to authorized users.

The server remains the authority for:

- who can access the file
- which files are seedable
- which devices may seed
- what chunks are valid
- which sources are trusted
- when a file should expire
- whether a seeder should be revoked

A downloader needs both:

- the file manifest/hash for integrity
- a server-issued short-lived token for access

Knowing a hash should not be enough to download a private Wabi file.

## Architecture

### Authority server

Responsibilities:

- stores file metadata and manifests
- signs manifests
- enforces permissions
- issues short-lived chunk access tokens
- tracks helper nodes and seeders
- selects sources
- acts as fallback source if configured
- revokes files/seeders
- exposes admin policy

### Helper node

Responsibilities:

- caches approved chunks
- reports available chunks
- serves chunks only with valid tokens
- obeys bandwidth/storage caps
- purges revoked files
- verifies cached content

### User seeder

Responsibilities:

- only seeds if user opted in
- only seeds approved files
- only serves token-authorized chunk requests
- can stop seeding anytime
- obeys local storage/bandwidth limits

### Downloader

Responsibilities:

- requests manifest from server
- receives authorized source list
- downloads chunks from server/helper/peers
- verifies every chunk
- retries missing or corrupt chunks
- assembles and verifies final file
- may optionally become a seeder

## Data flow

### Upload

1. Client splits file into chunks.
2. Client hashes each chunk.
3. Client computes whole-file hash.
4. Client submits manifest to server.
5. Server validates permissions and file policy.
6. Client uploads chunks.
7. Server verifies chunks.
8. Server finalizes the file.
9. Admin/channel policy may mark it seedable.
10. Helper nodes or opted-in users may cache chunks.

### Download

1. User requests file.
2. Server checks permission.
3. Server returns signed manifest and source list.
4. Client downloads chunks from one or more sources.
5. Client verifies each chunk hash.
6. Bad chunks are rejected and retried.
7. Whole file is verified after assembly.
8. User may save it, cache it, or opt into seeding.

### Seeding

1. User downloads or caches a file.
2. Wabi asks whether to help preserve it, or follows user policy.
3. Client registers chunk availability with server.
4. Server includes that seeder only for authorized downloaders.
5. Seeder validates short-lived tokens before sending chunks.
6. User can stop seeding and clear cache anytime.

## UX requirements

No spinner-only transfer UX.

A transfer UI should show:

- file name
- transferred bytes / total bytes
- completed chunks / total chunks
- progress percentage
- speed
- active sources
- transfer phase
- stalled/error state
- pause/resume/cancel/retry controls
- verification status
- seed/stop-seeding controls

Possible phases:

- preparing
- hashing
- waiting for sources
- requesting chunks
- transferring
- paused
- resuming
- verifying
- complete
- failed

## User controls

User settings should include:

- allow seeding: never / ask each time / trusted servers only / specific server
- cache size limit
- upload bandwidth limit
- seed only on Wi-Fi
- seed only while charging
- seed only while Wabi is open
- LAN-only seeding
- clear seed cache
- stop seeding all files

Default should be no user-device seeding unless explicitly enabled.

## Admin controls

Server-owner settings should include:

- enable/disable private swarm
- helper-node-only mode
- allow trusted user seeding
- roles allowed to seed
- channels allowed to mark files seedable
- max seedable file size
- max seed duration
- bandwidth caps
- storage caps
- pin file for preservation
- unpin file
- purge from helpers
- revoke seeder
- disable seeding for a file
- view source health
- view endangered files with too few sources

## Security model

### Required protections

- no public DHT by default
- no public tracker by default
- no global file search
- no anonymous arbitrary swarm joining
- no automatic hidden seeding
- no seeding to unauthorized users
- server-signed manifests
- per-chunk hashes
- whole-file hash
- short-lived access tokens
- revocation support
- cache quotas
- bandwidth limits
- source de-ranking for corrupt chunks

### Risks to disclose

- direct peer transfer may reveal IP addresses
- downloaded files cannot be perfectly clawed back from private copies
- hash verification proves integrity, not safety
- server owners are responsible for files they distribute
- malware scanning, if desired, should be a separate add-on/policy

## Encryption

The manifest should support future encrypted chunks even if MVP starts simpler.

Possible modes:

- no encryption for public/server-visible community files
- encrypted chunks for private/channel-scoped files

For encrypted mode:

- seeders store ciphertext
- downloaders need authorized keys
- chunk hashes should verify transport integrity
- AEAD tags verify decrypted content

Key management should be designed carefully and not rushed.

## Hashing

Recommended default: BLAKE3.

Reasons:

- very fast
- parallel-friendly
- excellent for large files
- strong Rust support
- good fit for chunk trees and huge assets

SHA-256 can be offered for compatibility/export if needed.

## Chunk size

Potential simple defaults:

- small files: 1 MiB
- normal large files: 4 or 8 MiB
- huge files: 16 MiB

A dynamic strategy can reduce metadata overhead for 50GB+ files.

## Implementation phases

### Phase 1: transfer manifest and local hashing

Deliverables:

- Rust transfer module/crate
- manifest structs
- BLAKE3 hashing
- chunk descriptors
- JSON serialization
- create manifest from file
- verify chunk
- verify whole file
- unit tests

### Phase 2: resumable upload

Deliverables:

- create upload session
- upload chunk endpoint
- upload status endpoint
- complete upload endpoint
- cancel upload endpoint
- temp chunk storage
- server-side hash verification

### Phase 3: resumable download

Deliverables:

- manifest endpoint
- chunk download endpoint
- client partial state
- retry missing chunks
- final verification
- progress UI

### Phase 4: helper-node blob cache

Deliverables:

- helper cache jobs
- helper chunk storage
- helper chunk serving with tokens
- authority source list
- admin pin/purge controls

### Phase 5: private swarm add-on

Deliverables:

- addon manifest
- peer/seeder registry
- user opt-in settings
- local seed cache
- chunk availability reporting
- multi-source downloader
- signed chunk access tokens
- server policy UI
- stop seeding / clear cache

### Phase 6: LAN and WebRTC peer transfer

Deliverables:

- LAN peer transfer where possible
- WebRTC DataChannel transport for browsers
- source scoring
- peer health tracking
- rarest-first or hybrid piece selection

### Phase 7: preservation UX

Deliverables:

- “help preserve this file” button
- seed health badges
- endangered file view
- release preservation channels
- admin dashboard

## What not to do

Do not:

- add public magnet links first
- join public BitTorrent DHT
- build a global Wabi tracker
- expose global hash search
- auto-seed downloads
- hide bandwidth usage
- let add-ons bypass file permissions
- promise perfect deletion after users download files
- frame Wabi as a piracy-resistant network

## Final recommendation

Build the foundation as normal Wabi file infrastructure:

1. hash-verified manifests
2. resumable chunks
3. detailed progress UI
4. helper-node cache
5. optional private swarm add-on

This gives Wabi most of the practical benefits of torrents while staying aligned with privacy, self-hosting, server-owner responsibility, and user consent.
