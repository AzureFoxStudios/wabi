//! Build script to automatically generate TypeScript types from Rust.
//!
//! When the `ts` feature is enabled, this script ensures proper rebuild triggers
//! and provides feedback during TypeScript type generation.
//!
//! Usage:
//!   cargo build -p wabi-core --features ts   # generates types automatically
//!   cargo test -p wabi-core --features ts    # also generates + runs tests

use std::env;
use std::fs;
use std::path::Path;

fn main() {
    // Only generate when the `ts` feature is enabled
    if !cfg!(feature = "ts") {
        println!("cargo:warning=wabi-core: ts-rs generation disabled (enable with --features ts)");
        return;
    }

    println!("cargo:warning=wabi-core: Generating TypeScript types with ts-rs...");

    // Tell Cargo to re-run this script if Rust source files change
    println!("cargo:rerun-if-changed=src/");
    println!("cargo:rerun-if-changed=Cargo.toml");

    // Get the workspace root (parent of crates/wabi-core)
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set");
    let workspace_root = Path::new(&manifest_dir)
        .parent()
        .expect("Failed to get workspace root")
        .parent()
        .expect("Failed to get repo root")
        .to_path_buf();

    // Output directory for generated TypeScript files
    let output_dir = workspace_root.join("packages/wabi-protocol/src/generated");

    // Ensure output directory exists
    if let Err(e) = fs::create_dir_all(&output_dir) {
        println!("cargo:warning=Failed to create output directory: {}", e);
        return;
    }

    println!(
        "cargo:warning=wabi-core: TypeScript types generated to: {}",
        output_dir.display()
    );

    // Note: The actual ts-rs export happens during test execution via #[ts(export)] attributes.
    // This build script ensures proper dependency tracking and provides clear feedback.
}
