//! Global commit index — canonical ordering of all committed mutations.
//!
//! The commit index is an append-only sequence of entries, each describing a
//! single committed mutation. Every entry stores the metadata needed to locate
//! the stream record(s) it produced, plus integrity hashes and caller identity.
//!
//! On-disk layout is defined in `docs/architecture/STORAGE_FORMAT.md` §3.

pub mod batcher;
pub mod record;
