//! Encrypted stopped-instance backup CLI; shared format implementation.
fn main() -> anyhow::Result<()> {
    wabi_server::instance_archive::run_cli()
}

// Retain the established binary-test target as well as library regression tests.
#[cfg(test)]
#[path = "../instance_archive/mod.rs"]
mod instance_archive_tests;
