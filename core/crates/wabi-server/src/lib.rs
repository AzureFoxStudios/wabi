//! Wabi Server library crate for integration testing
//! Mirrors the module tree of `main.rs` so integration tests can access
//! the public API (adapter, state, socketio types, etc.)

pub mod adapter;
pub mod anchor;
pub mod api;
pub mod auth_extractor;
pub mod blacklist;
pub mod blobs;
pub mod config;
pub mod error;
pub mod helper_api;
pub mod jobs;
pub mod lan;
pub mod mdns;
pub mod media;
pub mod mesh;
pub mod nodes;
pub mod rate_limit;
pub mod replication_transport;
pub mod socketio;
pub mod socketio_impl;
pub mod standby;
pub mod state;
pub mod upload_registry;
pub mod websocket;

#[cfg(feature = "wabi-lore")]
pub mod lore;
