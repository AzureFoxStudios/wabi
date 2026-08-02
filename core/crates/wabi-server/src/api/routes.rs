//! API router construction

use axum::Router;
use std::sync::Arc;

use crate::state::AppState;

use super::{
    addons, admin, albums, auth, blobs, bots, calls, channels, emoji, forum, gallery, incidents,
    jobs, lan, media, mesh, messages, nodes, operator, payments, places, preview, public, standby,
    sync, upload, user, wiki,
};
// lore is nested inside addons::routes (feature-gated there) — do not import here.

/// Create the main API router with all routes
pub fn create_api_router(state: Arc<AppState>) -> Router<Arc<AppState>> {
    // Build common routes
    let router = Router::new()
        // Public routes (no auth)
        .nest("/public", public::routes(state.clone()))
        // Setup status (called on every page load)
        .nest("/setup", public::setup_routes(state.clone()))
        // Auth routes
        .nest("/auth", auth::routes(state.clone()))
        // Bot account routes (owner-only token lifecycle)
        .nest("/bot", bots::routes(state.clone()))
        // User routes
        .nest("/user", user::routes(state.clone()))
        // Channel routes
        .nest("/channels", channels::routes(state.clone()))
        // Message routes
        .nest("/messages", messages::routes(state.clone()))
        // Upload routes
        .nest("/upload", upload::routes(state.clone()))
        // Media album routes
        .nest("/albums", albums::routes(state.clone()))
        // Wiki page routes
        .nest("/wiki", wiki::routes(state.clone()))
        // Forum thread & post routes
        .nest("/forum", forum::routes(state.clone()))
        // Gallery work & feedback routes
        .nest("/gallery", gallery::routes(state.clone()))
        // Incident routes
        .nest("/incidents", incidents::routes(state.clone()))
        // Call-session routes (replaces WDB call-session reducers)
        .nest("/calls", calls::routes(state.clone()))
        // Admin routes (policy management, compression, runtime, payments)
        .nest("/admin", admin::routes(state.clone()))
        // Payment routes (non-custodial provider integration)
        .nest("/payments", payments::routes(state.clone()))
        // Helper node registry routes
        .nest("/nodes", nodes::routes(state.clone()))
        // Blob storage routes (content-addressed)
        .nest("/blobs", blobs::routes(state.clone()))
        // Mesh coordination routes (multi-node discovery)
        .nest("/mesh", mesh::routes(state.clone()))
        // Break-glass operator routes (loopback + WABI_OPERATOR_SECRET only)
        .nest("/operator", operator::routes(state.clone()))
        // Addon capability list/get + nested lore (when feature on).
        // Lore lives inside addons::routes as /addons/lore/... (A2).
        .nest("/addons", addons::routes(state.clone()))
        // Places registry (R7b) — always JSON, never SPA HTML fallthrough.
        .nest("/places", places::routes(state.clone()))
        // Emoji / sticker upload routes
        .nest("/emoji", emoji::routes(state.clone()));

    router
        // Media room routing (helper-node SFU assignment)
        .nest("/media", media::routes(state.clone()))
        // Job queue routes
        .nest("/jobs", jobs::routes(state.clone()))
        // Warm standby snapshot receive route (encrypted envelopes only)
        .nest("/standby", standby::routes(state.clone()))
        // Database replication sync (commit index pull/push)
        .nest("/sync", sync::routes(state.clone()))
        // Whiteboard routes (image upload & file serving)
        .nest("/whiteboard", super::whiteboard::routes(state.clone()))
        // URL preview / image proxy (mounted at /url-preview and /image-proxy)
        .route("/url-preview", axum::routing::get(preview::url_preview))
        .route("/image-proxy", axum::routing::get(preview::image_proxy))
        // Profile picture upload (multipart POST, returns { profilePictureUrl })
        .route(
            "/upload-profile-picture",
            axum::routing::post(upload::upload_profile_picture),
        )
        // LAN acceleration routes (signed local route tokens)
        .nest("/lan", lan::routes(state.clone()))
        // Media/TURN routes
        .nest("/media-turn", media_routes(state.clone()))
}

/// Media routes (TURN credentials, file uploads)
fn media_routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    use axum::routing::get;

    Router::new()
        .route(
            "/turn-credentials",
            get(super::auth::handle_turn_credentials),
        )
        .with_state(state)
}
