//! Stream log module — per-stream append-only segment files.
//!
//! Each stream's events are stored as a sequence of fixed-size segment files
//! (`.wseg`) in `streams/{kind}/{stream_id}/events/`. The [`segment_writer`]
//! module implements the writer side (wabidb-06); the [`segment_reader`]
//! module implements the reader side (wabidb-07).

pub mod recovery;
pub mod segment_reader;
pub mod segment_writer;
