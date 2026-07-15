# Patterns Worth Borrowing From Hyperscale System-Design Playbooks

## Why this file exists

While researching real-time / real-time-adjacent Wabi concerns we landed on
liquidslr/system-design-notes (a study-guide rendering of Alex Xu's "System
Design Interview" Vol 1 & 2). The full repo is hyperscale playbook material
(50M DAU, multi-DC, Kafka, Cassandra, Zookeeper, Snowflake, S3) and the wrong
fit for Wabi. **Do not vendor it, link it from the architecture index, or treat
its chapters as a reference.** This file extracts the ~5 techniques that
genuinely apply to Wabi's self-hosted / single-binary / OSS-independent model
and notes what the Wabi-flavored version of each looks like. The original
chapters are fine as *vocabulary reading* — not as a source of architecture
decisions.

## What a "technique" means here

A technique is a small, focused pattern you implement in 50-500 lines of Rust
when the feature needs it. It is not an app, library, or service to import.
Wabi never "adds a search system" — Wabi adds a 100-line trie (or sorted
BTree) prefix index. Wabi never "adds a message queue" — Wabi adds a
`tokio::mpsc` channel or a STDB job table. The chapters describe Kafka-tier
implementations; the technique is the small idea underneath them.

## Patterns worth keeping

### 1. Trie (or sorted-prefix index) for typeahead

- **Source pattern.** Chapter 13 (Search Autocomplete). Walk a tree where each
  node is a character; collect all children of the prefix node; return the
  top-k by frequency.
- **Wabi use case.** DM participant search, channel name search, @mention
  autocomplete, command-palette search.
- **Wabi-flavor.** A flat `Vec<(String, u32)>` sorted by name with binary
  search for the first prefix match, then a linear scan forward, is enough up
  to ~10k items. For larger, a real trie or `fst` crate. **Not** a search
  service.
- **Don't.** Don't pull in Elasticsearch / Typesense / Meilisearch for this.
  Wabi's autocomplete target is single-community, not global.

### 2. Chunked resumable upload

- **Source pattern.** Chapter 14 (YouTube) upload flow + Chapter 15 (Google
  Drive) block servers. Client splits file into chunks (4 MB typical),
  uploads them in parallel with individual retry, server tracks a per-upload
  bitmask of received chunks, finalizes when complete.
- **Wabi use case.** File attachments, P2P file transfer, profile pictures,
  imported media bundles.
- **Wabi-flavor.** A `POST /uploads/init` returns a `upload_id` and chunk
  size; `PUT /uploads/:id/chunk/:n` accepts one chunk; `POST /uploads/:id/
  finalize` assembles + hashes + writes to disk. The frontend shows real
  byte-by-byte progress, pause, resume, retry — *this is the user-visible
  bit Ronin already flagged as required*.
- **Don't.** Don't reinvent per-chunk dedup, resumable across sessions, or
  cross-device resume until P2P file transfer lands. Do those together.

### 3. Content-addressable blocks for file dedup / diff sync

- **Source pattern.** Chapter 15 (Google Drive) block storage + Delta Sync.
  Split file into fixed-size blocks, hash each (SHA-256), store blocks by
  hash. A sync engine computes the set-difference between local and remote
  block hashes and transfers only missing blocks.
- **Wabi use case.** P2P file transfer where the recipient may already have
  some of the bytes (resuming a download, transferring a file the recipient
  has a partial copy of, sending the same file to multiple people).
- **Wabi-flavor.** A `blocks/` directory on disk, each block named
  `<sha256>.bin`. Metadata row in STDB says "this file is blocks
  [hash, hash, hash, ...] in order." Send the recipient the list of hashes;
  they request only what they don't have.
- **Don't.** Don't add this until P2P file transfer is a real feature, not
  a wishlist item. Adds nontrivial complexity for zero benefit on the
  current "upload, then download again" flow.

### 4. Producer / consumer decoupling (the actual MQ idea)

- **Source pattern.** Chapter 19 (Distributed Message Queue). The whole
  chapter is "decouple so your API doesn't have to wait for stuff," with
  Kafka-tier deep dive.
- **Wabi use case.** Every "do this now, and also do these other things
  later" interaction. Sending a message: deliver now, index for search
  later, push-notify offline users later, update cursors later, post
  webhooks later, bump stats later. Same shape for uploads, mod actions,
  channel creates, role changes, voice-channel events.
- **Wabi-flavor.** A `tokio::sync::mpsc` channel fed by the request
  handlers, drained by N worker tasks. For cross-restart durability (jobs
  that must survive a server restart), a STDB or SQLite `jobs` table polled
  by a worker. Retries with exponential backoff. Dead-letter table for
  terminal failures. **That is the entire pattern.** No Kafka, no Zookeeper,
  no consumer groups.
- **Don't.** Don't add RabbitMQ, NATS, Redis Streams, or any external
  broker. Wabi's worker pool is a few `tokio` tasks in the same binary.
  External MQ adds an operational dependency for no scaling benefit at
  Wabi's target.

### 5. Idempotency keys for any "fire-and-forget that must not double-fire"

- **Source pattern.** Chapter 26 (Payment) idempotency section. Client sends
  an `Idempotency-Key` header (typically a UUID); server keeps a unique
  constraint on (operation, key); a duplicate request returns the original
  result instead of executing again.
- **Wabi use case.** Any client retry that could double-execute:
  "send this message," "react to this message," "create this channel,"
  "ban this user," "transfer this file." A flaky mobile network + a
  retrying client should never produce two messages.
- **Wabi-flavor.** A `client_request_id` field on the relevant STDB row
  with a unique constraint. Client generates a UUID per logical action and
  sends it; the reducer (or Rust handler) checks for duplicates and
  short-circuits.
- **Don't.** Don't add this everywhere by default. Add it where a
  duplicate is harmful (financial actions, message creation, RBAC changes)
  and not where a duplicate is benign (read queries, presence heartbeats).

## Patterns deliberately NOT borrowed

These chapters were read and judged out-of-scope for Wabi. Recording the
judgment so we don't re-litigate later.

- **Chapter 18 (Google Maps).** Geohash, map tiles, A* routing, geocoding.
  Skip the chapter. Wabi embeds Leaflet/MapLibre + calls OSRM/Valhalla for
  routing; stores lat/lng as plain STDB rows. See the directions/maps
  discussion in the session notes.
- **Chapter 20 (Metrics / Alerting).** Time-series DB, downsampling,
  rollups, PagerDuty. Wabi's admin dashboard is a `/admin/stats` page that
  runs aggregations over the existing `events` table. `tracing` +
  `tracing-subscriber` to a rotating log file is enough until proven
  otherwise.
- **Chapter 22 (Hotel Reservation), 26 (Payment), 27 (Digital Wallet).**
  Double-entry ledgers, PSP integration, distributed transactions, event
  sourcing with RocksDB + Raft. Wabi is not moving money. If a community
  ever needs payments, use Stripe Checkout (hosted) and never write a
  payment system. Skip.
- **Chapter 24 (S3-like Object Storage).** Sharded, multi-DC, replicated
  object store. Wabi's media layer is a directory of files on disk with a
  STDB metadata row. Single-node, no sharding, no replication. Skip the
  chapter.
- **Chapter 25 (Real-time Gaming Leaderboard).** Skip; Wabi has no
  leaderboards. If ever added, Redis sorted set is the boring answer.
- **Chapter 28 (Stock Exchange).** Out of scope on its face. Skip.

## Vocabulary reading order, if curious

If you want the chapters as background reading, this is the order they
become useful as Wabi features appear:

1. Chapter 4 (Rate Limiter) — when adding anti-spam or per-user quotas.
2. Chapter 12 (Chat System) — for the multi-device-cursor pattern when
   Tauri desktop + browser sync needs tightening.
3. Chapter 14 (YouTube) — for chunked resumable upload (pattern 2 above).
4. Chapter 15 (Google Drive) — for content-addressable blocks (pattern 3).
5. Chapter 19 (Distributed Message Queue) — for the worker-pool design
   (pattern 4), read the *intro and messaging models* sections, skip the
   Kafka internals.

Everything else is reading for fun, not for Wabi decisions.

## Maintenance

This file is a session artifact, not architecture gospel. If a chapter
turns out to be more relevant than this doc claims, or a pattern here is
rejected by an actual Wabi implementation, patch in place. Don't let it
drift from what the codebase actually does.
