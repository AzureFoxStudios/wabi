//! Compile the real production modules; do not copy or mock their behavior.
#![allow(dead_code)]
#[path = "../../src-tauri/src/hosting/archive.rs"]
mod archive;
#[path = "../../src-tauri/src/hosting/process.rs"]
mod process;

#[path = "../../src-tauri/src/hosting/bounded.rs"]
mod bounded;
#[path = "../../core/crates/wabi-server/src/bootstrap_guard.rs"]
mod bootstrap_guard;
