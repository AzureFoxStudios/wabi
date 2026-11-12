//! wabi-sync as a library: the REST client, the local state files and the
//! sync engine that the `wabi-sync` binary drives. It is a library so that
//! wabi-server's contract tests can run this exact client against the real
//! router (`core/crates/wabi-server/tests/wabi_sync_contract.rs`).

pub mod api;
pub mod config;
pub mod etag;
#[cfg(test)]
mod large_file_tests;
#[cfg(test)]
mod review_tests;
pub mod sync;
