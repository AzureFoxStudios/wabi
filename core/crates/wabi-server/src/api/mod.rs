//! API route handlers

pub mod admin;
pub mod operator;
pub mod albums;
pub mod calls;
pub mod auth;
pub mod blobs;
pub mod channels;
pub mod forum;
pub mod gallery;
pub mod incidents;
pub mod wiki;
pub mod jobs;
pub mod lan;
pub mod media;
pub mod mesh;
#[cfg(feature = "wabi-lore")]
pub mod lore;
pub mod messages;
pub mod nodes;
pub mod payments;
pub mod preview;
pub mod public;
pub mod routes;
pub mod standby;
pub mod sync;
pub mod state;
pub mod upload;
pub mod user;
pub mod whiteboard;
mod path_util;
