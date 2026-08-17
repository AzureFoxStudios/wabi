//! First-boot onboarding contract:
//! - a fresh server boots with zero required env (root key auto-generated)
//! - exactly one account may be created in the setup window (the owner)
//! - once an owner exists, registration follows the normal auth policy

use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

use wabi_server::api::routes::create_api_router;
use wabi_server::config::{LoreAddonConfig, ServerConfig, ServerRole};
use wabi_server::state::AppState;

fn test_config(data_dir: &Path) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: data_dir.to_string_lossy().into_owned(),
        uploads_dir: data_dir.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "test-jwt-secret".into(),
        turn_enabled: false,
        turn_uri: None,
        turn_secret: None,
        node_id: "node-test".into(),
        is_primary: true,
        server_role: ServerRole::Authority,
        authority_url: None,
        admin_user_ids: vec![],
        blacklist_file: data_dir.join("blacklist.txt").to_string_lossy().into_owned(),
        max_body_size: None,
        mesh_enabled: false,
        mesh_peers: vec![],
        lore: LoreAddonConfig {
            enabled: false,
            mode: "sidecar".into(),
            server_url: "lore://localhost:10000".into(),
            binary_path: "lore".into(),
            data_dir: "/var/wabi/lore".into(),
            default_blob_max_size_mb: 1024,
            auto_create_repos: true,
            recordings_channel_name: None,
        },
    }
}

async fn fresh_server() -> (tempfile::TempDir, axum::Router) {
    let tmp = tempfile::TempDir::new().unwrap();
    let config = test_config(tmp.path());
    let state = Arc::new(AppState::new(config).await.unwrap());
    let app = create_api_router(state.clone()).with_state(state);
    (tmp, app)
}

fn register_request(username: &str) -> Request<Body> {
    let body = serde_json::json!({ "username": username, "password": "password123" }).to_string();
    Request::post("/auth/register")
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap()
}

async fn setup_required(app: &axum::Router) -> bool {
    let response = app
        .clone()
        .oneshot(Request::get("/setup/status").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .unwrap()
        .get("setupRequired")
        .and_then(|v| v.as_bool())
        .unwrap()
}

#[tokio::test]
async fn fresh_boot_generates_root_key_with_no_env() {
    let (tmp, _app) = fresh_server().await;
    // The engine opened successfully and persisted a root key next to its data
    // with no WABIDB_ROOT_KEY configured (turnkey first boot).
    assert!(
        tmp.path().join("wabidb/root_key").exists(),
        "expected auto-generated root_key at <data_dir>/wabidb/root_key"
    );
}

#[tokio::test]
async fn concurrent_first_registrations_create_exactly_one_owner() {
    let (_tmp, app) = fresh_server().await;
    assert!(setup_required(&app).await, "fresh server must require setup");

    let (a, b) = tokio::join!(
        app.clone().oneshot(register_request("alice")),
        app.clone().oneshot(register_request("bob")),
    );
    let statuses = [a.unwrap().status(), b.unwrap().status()];
    assert_eq!(
        statuses,
        [StatusCode::OK, StatusCode::CONFLICT],
        "exactly one concurrent first registration may succeed; got {statuses:?}"
    );

    assert!(
        !setup_required(&app).await,
        "owner claim must clear the setup window"
    );

    // After the owner exists, the open-by-default policy applies again.
    let later = app
        .clone()
        .oneshot(register_request("carol"))
        .await
        .unwrap();
    assert_eq!(later.status(), StatusCode::OK, "post-setup registration under the default open policy must succeed");
}
