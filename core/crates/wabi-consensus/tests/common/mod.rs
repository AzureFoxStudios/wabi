//! Fork gate for this crate's integration-test binaries.
//!
//! `src/fork_gate.rs` is `#[cfg(test)]` inside the library, so it guards the
//! unit-test binary only: integration tests link the library built without
//! `cfg(test)`, where `Store::open` takes no gate. Their binaries spawn
//! children of themselves too, and a child holds copies of every open
//! descriptor until it execs, including a store lock another test has just
//! dropped. An immediate reopen or lock probe is then refused with
//! `Ownership` although this process released everything.
//!
//! The same source file is compiled in here (not duplicated, not made public,
//! not part of any production build), and its contract applies to the callers:
//! every child is created through [`spawn`], and every `Store::open` in these
//! binaries goes through [`open_store`], which holds the gate shared for the
//! open only. Each flock this crate takes (the store's `.lock` and redb's lock
//! on `consensus.redb`) is acquired inside `Store::open` and never duplicated
//! afterwards, so that covers every acquisition and every probe.
//!
//! The hold is per open, not per test body: a test that opens and later
//! spawns would otherwise ask for the exclusive gate while holding it shared
//! and deadlock, and long cluster tests would block every other spawn.
//! Dropping a store needs no gate; only the reopen must not overlap a spawn.
use std::path::Path;
use wabi_consensus::{
    model::StoreBinding,
    store::{Store, StoreError, StoreLimits},
};

#[path = "../../src/fork_gate.rs"]
mod fork_gate;

pub(crate) use fork_gate::spawn;

/// `Store::open`, never concurrent with a sibling test's child between fork
/// and exec. The gate is released before the store is returned.
pub(crate) fn open_store(
    root: &Path,
    binding: StoreBinding,
    limits: StoreLimits,
) -> Result<Store, StoreError> {
    let _fork_gate = fork_gate::acquire();
    Store::open(root, binding, limits)
}
