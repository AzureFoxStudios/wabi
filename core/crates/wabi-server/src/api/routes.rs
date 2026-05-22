//! API router construction

use axum::Router;
use std::sync::Arc;

use crate::state::AppState;

use super::{albums, auth, channels, messages, payments, preview, public, upload, user};

/// Create the main API router with all routes
pub fn create_api_router(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        // Public routes (no auth)
        .nest("/public", public::routes(state.clone()))
        // Setup status (called on every page load)
        .nest("/setup", public::setup_routes(state.clone()))
        // Auth routes
        .nest("/auth", auth::routes(state.clone()))
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
        // Payment routes (non-custodial provider integration)
        .nest("/payments", payments::routes(state.clone()))
        // Whiteboard routes (image upload & file serving)
        .nest("/whiteboard", super::whiteboard::routes(state.clone()))
        // URL preview / image proxy (mounted at /url-preview and /image-proxy)
        .route("/url-preview", axum::routing::get(preview::url_preview))
        .route("/image-proxy", axum::routing::get(preview::image_proxy))
        // Profile picture upload (multipart POST, returns { profilePictureUrl })
        .route("/upload-profile-picture", axum::routing::post(upload::upload_profile_picture))
        // Media/TURN routes
        .nest("/media", media_routes(state.clone()))
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
