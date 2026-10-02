//! Wabi Server library crate for integration testing
//! Mirrors the module tree of `main.rs` so integration tests can access
//! the public API (adapter, state, socketio types, etc.)

pub mod adapter;
pub mod addon_switches;
pub mod anchor;
pub mod api;
pub mod app_router;
pub mod auth_extractor;
pub(crate) mod auth_credentials;
pub(crate) mod auth_revocations;
pub(crate) mod recovery_codes;
pub mod blacklist;
pub mod blobs;
pub mod bootstrap_guard;
pub mod bot_delivery;
pub mod bot_registry;
pub mod call_access;
pub mod channel_access;
pub mod config;
pub mod community_roster;
pub mod error;
pub mod helper_api;
pub mod instance_sidecars;
pub mod instance_operations;
pub mod instance_checkpoint;
pub mod checkpoint_jobs;
#[cfg(target_os = "linux")]
pub mod recovery_peer_jobs;
pub mod instance_archive;
pub mod jobs;
pub mod lan;
pub mod listener;
pub mod mdns;
pub mod media;
pub mod metrics;
pub mod nodes;
pub mod rate_limit;
pub mod replication_transport;
pub mod secrets;
pub mod socketio;
pub mod socketio_impl;
pub mod standby;
pub mod state;
pub mod upload_registry;
pub mod websocket;

#[cfg(feature = "wabi-lore")]
pub mod lore;
pub mod lore_roles;
