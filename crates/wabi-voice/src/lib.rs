//! Native voice engine for the Wabi desktop shell.
//!
//! The webview on Linux (WebKitGTK) has no echo cancellation, noise
//! suppression or gain control, and its audio path costs a lot of memory in a
//! call. This crate does microphone capture, processing, Opus and playback
//! outside the webview. The page keeps admission, signalling and the socket;
//! it hands received relay pages to the engine and sends the pages the engine
//! produces.

pub mod engine;
#[cfg(feature = "livekit")]
pub mod livekit;
pub mod ogg;
pub mod pipeline;
pub mod processing;
