//! Socket.IO real-time layer public facade.
//!
//! The implementation lives in `socketio_impl.rs` so this module can stay small
//! while preserving the existing `crate::socketio` API used by `main.rs`.

#[path = "socketio_impl.rs"]
mod socketio_impl;

pub use socketio_impl::*;
