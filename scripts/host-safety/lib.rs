//! Compile the real production modules; do not copy or mock their behavior.
#![allow(dead_code)]
#[path = "../../src-tauri/src/hosting/archive.rs"]
mod archive;
#[path = "../../src-tauri/src/hosting/process.rs"]
mod process;

#[path = "../../core/crates/wabi-server/src/bootstrap_guard.rs"]
mod bootstrap_guard;
#[path = "../../src-tauri/src/hosting/bounded.rs"]
mod bounded;

#[path = "../../src-tauri/src/hosting/profile.rs"]
mod profile;

#[cfg(test)]
mod authority;

#[path = "../../src-tauri/src/hosting/lan.rs"]
mod lan;
