//! Encrypted stopped-instance backup CLI; shared format implementation.
fn main() -> anyhow::Result<()> {
    wabi_server::instance_archive::run_cli()
}

// Retain the established binary-test target as well as library regression tests.
#[cfg(test)]
use wabi_server::{addon_switches, checkpoint_jobs, config, state, upload_registry};
#[cfg(test)]
#[path = "../instance_archive/mod.rs"]
mod instance_archive_tests;
