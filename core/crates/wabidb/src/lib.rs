//! WabiDB — per-stream log-structured object/event store with a global commit index.
//!
//! WabiDB is the custom storage engine for the Wabi self-hosted platform. It replaces
//! wabiDB as the source of truth for messages, channels, DMs, and helper-node state.
//!
//! ## Architecture overview
//!
//! - **Per-stream segments** (`stream_log`): append-only files, one per stream, AES-256-GCM
//!   encrypted with the stream's key. Each segment holds records identified by `commit_seq`.
//! - **Global commit index** (`commit_index`): the canonical ordering of all commits. Every
//!   committed mutation has exactly one entry. The index is the source of truth for recovery.
//! - **Commit sequencer** (`sequencer`): a single async task holding a `Semaphore(1)` permit
//!   (see `engine::locks`). Assigns monotonic `commit_seq`, writes to per-stream segments,
//!   appends to the commit index, fsyncs. Projections update asynchronously.
//! - **Projections** (`projections`): materialized views of the commit log, indexed for
//!   read-path queries. Lock-free `crossbeam-skiplist::SkipMap` per index. Rebuildable from
//!   snapshots + post-snapshot commit index entries.
//! - **Subscription engine** (`subscription`): topic-based pub/sub with snapshot barrier,
//!   resume, ticket-auth WebSocket, and membership revalidation.
//! - **Ephemeral bus** (`ephemeral`): in-memory broadcast for events that must not survive
//!   a crash (typing, call signals, cursor movement).
//! - **Retention engine** (`retention`): per-scope TTL with cryptographic deletion (key
//!   destruction + tombstone) and segment compaction.
//! - **Blob store** (`blobs`): BLAKE3 content-addressed files, atomic write ordering, range
//!   read protocol.
//! - **Storage CLI** (`cli`): operator-facing tools (`wabidb check`, `dump-stream`,
//!   `rebuild-indexes`, manifest-based backup).
//!
//! ## Design references
//!
//! - Endstate doc: `/var/home/Ronin/wabi/docs/proposals/wabidb-endstate.md`
//! - Council reviews: `/var/home/Ronin/wabi/docs/architecture/wabidb-council-reviews.md`
//! - Kanban: `/var/home/Ronin/wabi/docs/wabidb-kanban.md`

#![allow(clippy::needless_return)]

// Top-level modules. Each is filled in by its own kanban card.
pub mod auth;
pub mod blobs;
pub mod cli;
pub mod commands;
pub mod commit_index;
pub mod crypto;
pub mod ephemeral;
pub mod engine;
pub mod error;
pub mod format;
pub mod fuzz;
pub mod maintenance;
pub mod projections;
pub mod protocol;
pub mod replication;
pub mod retention;
pub mod sequencer;
pub mod snapshots;
pub mod storage;
pub mod stream_log;
pub mod subscription;
#[cfg(test)]
pub mod tests;
pub mod domain;
