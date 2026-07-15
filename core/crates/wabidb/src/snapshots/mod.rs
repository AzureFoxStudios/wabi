//! Snapshot system: per-stream snapshots of projection state.
//!
//! Snapshots anchor projection rebuilds and are stored as
//! `{snapshot_seq:08}.wsnap` files.

pub mod writer;
