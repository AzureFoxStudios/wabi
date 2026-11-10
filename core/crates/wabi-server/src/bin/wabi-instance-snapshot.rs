//! Encrypted stopped-instance backup CLI; shared format implementation.
fn main() -> anyhow::Result<()> {
    wabi_server::instance_archive::run_cli()
}

// Retain the established binary-test target as well as library regression tests.
#[cfg(test)]
use wabi_server::{addon_switches, checkpoint_jobs, config, state, upload_registry};
// Test binaries only: the one wabi-consensus fork gate source, included
// rather than copied or exported. This crate's test child spawns and the
// flock acquisitions racing them go through it (see that file).
#[cfg(test)]
#[path = "../../../wabi-consensus/src/fork_gate.rs"]
mod fork_gate;
#[cfg(test)]
#[path = "../instance_archive/mod.rs"]
mod instance_archive_tests;
