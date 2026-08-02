//! Places registry endpoint.
//!
//! `GET /api/places` returns a JSON list so the SPA never receives the
//! static `index.html` fallback (200 text/html) for this path.
//!
//! Empty list is intentional until a real place store is wired — client
//! (`placeStore.ts`) already treats `{ places: [] }` as loaded-empty.

use axum::{extract::State, Json, Router};
use serde::Serialize;
use std::sync::Arc;

use crate::error::Result;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacesListResponse {
    pub places: Vec<serde_json::Value>,
}

/// GET /api/places — empty registry stub (real store later).
async fn list_places(State(_state): State<Arc<AppState>>) -> Result<Json<PlacesListResponse>> {
    Ok(Json(PlacesListResponse { places: vec![] }))
}

/// Nested at `/places` under the API router → `/api/places`.
pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/", axum::routing::get(list_places))
        .with_state(state)
}
