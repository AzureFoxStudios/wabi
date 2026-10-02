//! API route handlers

pub mod addons;
pub mod admin;
pub mod albums;
pub mod auth;
pub mod blobs;
pub mod bots;
pub mod cad;
pub mod calls;
pub mod channels;
pub mod community;
pub mod conversation_notes;
pub mod e2ee;
pub mod emoji;
pub mod field;
pub mod following;
pub mod forum;
pub mod friends;
pub mod gallery;
pub mod incidents;
pub mod jobs;
pub mod lan;
#[cfg(feature = "wabi-lore")]
pub mod lore;
#[cfg(feature = "wabi-lore")]
mod lore_auth;
pub mod media;
pub mod media_permissions;
pub(crate) mod voice_policy;
pub(crate) mod voice_self_state;
pub(crate) mod media_node_catalog;
pub mod messages;
pub mod nodes;
pub mod operator;
mod path_util;
pub mod payments;
pub mod places;
pub mod preview;
pub mod privacy;
pub mod project_tasks;
pub mod project_runs;
pub mod public;
pub mod retention_policy;
pub mod routes;
pub mod server_center;
pub mod standby;
pub mod steam;
pub mod sync;
pub mod tailcat;
pub mod upload;
pub mod user;
pub mod whiteboard;
pub mod wiki;

pub mod games;
pub mod invites;

pub mod boosters;
pub mod network_health;

pub mod service_access;

pub mod whiteboard_policy;
pub mod workspace;
mod workspace_crdt;
mod workspace_present;
