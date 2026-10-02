//! First-boot onboarding contract:
//! - a fresh server boots with zero required env (root key auto-generated)
//! - exactly one account may be created in the setup window (the owner)
//! - once an owner exists, registration follows the normal auth policy

#[path = "fixtures/writer_drain.rs"]
mod writer_drain;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

use wabi_server::api::routes::create_api_router;
use wabi_server::app_router::build_app_router;
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
        blacklist_file: data_dir
            .join("blacklist.txt")
            .to_string_lossy()
            .into_owned(),
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

async fn wait_for_writer_drain(data_dir: &Path) {
    // Stopped-data subprocesses acquire the same persistent inode themselves.
    // Release this test probe before invoking them.
    drop(writer_drain::wait_for_stopped_engine(&data_dir.join("wabidb")).await);
}

fn register_request(username: &str) -> Request<Body> {
    let body = serde_json::json!({ "username": username, "password": "password123" }).to_string();
    let mut request = Request::post("/auth/register")
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 42001))));
    request
}

async fn setup_required(app: &axum::Router) -> bool {
    let response = app
        .clone()
        .oneshot(Request::get("/setup/status").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
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
async fn authority_refuses_existing_uploads_without_registry() {
    let tmp = tempfile::TempDir::new().unwrap();
    let uploads = tmp.path().join("uploads");
    std::fs::create_dir(&uploads).unwrap();
    std::fs::write(uploads.join("old-file.bin"), b"old content").unwrap();

    let error = match AppState::new(test_config(tmp.path())).await {
        Ok(_) => panic!("Authority must refuse upload bytes without revocation history"),
        Err(error) => error,
    };
    assert!(
        error
            .to_string()
            .contains("upload_registry.json is missing"),
        "unexpected startup error: {error}"
    );
    assert_eq!(
        std::fs::read(uploads.join("old-file.bin")).unwrap(),
        b"old content"
    );
}

#[tokio::test]
async fn authority_restores_canonical_upload_revocation_over_stale_registry() {
    let tmp = tempfile::TempDir::new().unwrap();
    let config = test_config(tmp.path());
    let state = AppState::new(config.clone()).await.unwrap();
    state
        .upload_registry
        .record(
            "private.bin",
            "private.bin",
            None,
            Some(1),
            wabi_server::upload_registry::UploadKind::Attachment,
            7,
        )
        .await
        .unwrap();
    state
        .upload_registry
        .revoke_canonical("private.bin", state.wdb.engine(), 1)
        .await
        .unwrap();
    drop(state);

    std::fs::write(
        tmp.path().join("upload_registry.json"),
        br#"{"files":{},"revoked":[]}"#,
    )
    .unwrap();
    let reopened = writer_drain::app_state(&config).await.unwrap();
    assert!(reopened.upload_registry.is_revoked("private.bin").await);
    assert!(
        wabi_server::upload_registry::UploadRegistry::new_persistent(tmp.path())
            .unwrap()
            .is_revoked("private.bin")
            .await
    );
}

#[tokio::test]
async fn authority_rebuilds_stale_upload_metadata_only_from_matching_bytes() {
    let tmp = tempfile::TempDir::new().unwrap();
    let config = test_config(tmp.path());
    let state = AppState::new(config.clone()).await.unwrap();
    state
        .upload_registry
        .publish_bytes(
            Path::new(&config.uploads_dir),
            state.wdb.engine(),
            "recover.bin",
            "original.bin",
            None,
            None,
            Some(1),
            wabi_server::upload_registry::UploadKind::Attachment,
            b"right",
        )
        .await
        .unwrap();
    drop(state);
    let registry_path = tmp.path().join("upload_registry.json");
    std::fs::write(&registry_path, br#"{"files":{},"revoked":[]}"#).unwrap();
    let reopened = writer_drain::app_state(&config).await.unwrap();
    assert_eq!(
        reopened
            .upload_registry
            .get("recover.bin")
            .await
            .unwrap()
            .original_name,
        "original.bin"
    );
    drop(reopened);

    std::fs::write(&registry_path, br#"{"files":{},"revoked":[]}"#).unwrap();
    std::fs::write(tmp.path().join("uploads/recover.bin"), b"wrong").unwrap();
    let error = match writer_drain::app_state(&config).await {
        Ok(_) => panic!("Authority must reject restored upload bytes with the wrong digest"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("upload digest differs"));
}

#[tokio::test]
async fn authority_finishes_verified_uploads_staged_at_publication_crash() {
    let tmp = tempfile::TempDir::new().unwrap();
    let config = test_config(tmp.path());
    let state = AppState::new(config.clone()).await.unwrap();
    let uploads = Path::new(&config.uploads_dir);
    let direct_name = "interrupted.bin";
    state
        .upload_registry
        .publish_bytes(
            uploads,
            state.wdb.engine(),
            direct_name,
            "direct.bin",
            None,
            None,
            Some(1),
            wabi_server::upload_registry::UploadKind::Attachment,
            b"direct bytes",
        )
        .await
        .unwrap();
    let direct_stage = uploads.join(".tmp").join(format!(
        "registry-{}",
        hex::encode(Sha256::digest(direct_name.as_bytes()))
    ));
    std::fs::rename(uploads.join(direct_name), &direct_stage).unwrap();

    let resumable_id = "550e8400-e29b-41d4-a716-446655440000";
    let resumable_name = format!("{resumable_id}.bin");
    state
        .upload_registry
        .publish_bytes(
            uploads,
            state.wdb.engine(),
            &resumable_name,
            "resumable.bin",
            None,
            None,
            Some(1),
            wabi_server::upload_registry::UploadKind::Attachment,
            b"resumable bytes",
        )
        .await
        .unwrap();
    std::fs::rename(
        uploads.join(&resumable_name),
        uploads.join(".tmp").join(resumable_id),
    )
    .unwrap();
    drop(state);

    let reopened = writer_drain::app_state(&config).await.unwrap();
    assert_eq!(
        std::fs::read(uploads.join(direct_name)).unwrap(),
        b"direct bytes"
    );
    assert_eq!(
        std::fs::read(uploads.join(&resumable_name)).unwrap(),
        b"resumable bytes"
    );
    assert!(!direct_stage.exists());
    assert!(!uploads.join(".tmp").join(resumable_id).exists());
    drop(reopened);
}

#[tokio::test]
async fn authority_refuses_mismatched_staged_upload_after_publication_crash() {
    let tmp = tempfile::TempDir::new().unwrap();
    let config = test_config(tmp.path());
    let state = AppState::new(config.clone()).await.unwrap();
    let uploads = Path::new(&config.uploads_dir);
    let filename = "interrupted.bin";
    state
        .upload_registry
        .publish_bytes(
            uploads,
            state.wdb.engine(),
            filename,
            filename,
            None,
            None,
            Some(1),
            wabi_server::upload_registry::UploadKind::Attachment,
            b"right",
        )
        .await
        .unwrap();
    let stage = uploads.join(".tmp").join(format!(
        "registry-{}",
        hex::encode(Sha256::digest(filename.as_bytes()))
    ));
    std::fs::rename(uploads.join(filename), &stage).unwrap();
    std::fs::write(&stage, b"wrong").unwrap();
    drop(state);

    let error = match writer_drain::app_state(&config).await {
        Ok(_) => panic!("Authority must reject changed staged upload bytes"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("staged upload bytes differ"));
    assert!(!uploads.join(filename).exists());
}

#[tokio::test]
async fn authority_does_not_publish_uncommitted_private_upload() {
    let tmp = tempfile::TempDir::new().unwrap();
    let config = test_config(tmp.path());
    let state = AppState::new(config.clone()).await.unwrap();
    let filename = "uncommitted.bin";
    let uploads = Path::new(&config.uploads_dir);
    let stage = uploads.join(".tmp").join(format!(
        "registry-{}",
        hex::encode(Sha256::digest(filename.as_bytes()))
    ));
    std::fs::create_dir_all(stage.parent().unwrap()).unwrap();
    std::fs::write(&stage, b"private bytes").unwrap();
    state
        .upload_registry
        .record(
            filename,
            filename,
            None,
            Some(1),
            wabi_server::upload_registry::UploadKind::Attachment,
            13,
        )
        .await
        .unwrap();
    drop(state);

    let reopened = writer_drain::app_state(&config).await.unwrap();
    assert!(stage.exists());
    assert!(!uploads.join(filename).exists());
    drop(reopened);
}

#[tokio::test]
async fn authority_refuses_changed_published_bytes_with_current_registry() {
    let tmp = tempfile::TempDir::new().unwrap();
    let config = test_config(tmp.path());
    let state = AppState::new(config.clone()).await.unwrap();
    state
        .upload_registry
        .publish_bytes(
            Path::new(&config.uploads_dir),
            state.wdb.engine(),
            "changed.bin",
            "changed.bin",
            None,
            None,
            Some(1),
            wabi_server::upload_registry::UploadKind::Attachment,
            b"right",
        )
        .await
        .unwrap();
    drop(state);

    std::fs::write(Path::new(&config.uploads_dir).join("changed.bin"), b"wrong").unwrap();
    let error = match writer_drain::app_state(&config).await {
        Ok(_) => panic!("Authority must reject changed canonical bytes with a current registry"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("upload digest differs"));
}

#[tokio::test]
async fn upload_head_and_conditional_get_recheck_revocation() {
    let tmp = tempfile::TempDir::new().unwrap();
    let config = test_config(tmp.path());
    let state = Arc::new(AppState::new(config.clone()).await.unwrap());
    state
        .upload_registry
        .publish_bytes(
            Path::new(&config.uploads_dir),
            state.wdb.engine(),
            "canonical.bin",
            "canonical.bin",
            None,
            None,
            Some(1),
            wabi_server::upload_registry::UploadKind::Attachment,
            b"regional bytes",
        )
        .await
        .unwrap();
    state
        .upload_registry
        .record(
            "legacy.bin",
            "legacy.bin",
            None,
            Some(1),
            wabi_server::upload_registry::UploadKind::Attachment,
            6,
        )
        .await
        .unwrap();
    std::fs::write(Path::new(&config.uploads_dir).join("legacy.bin"), b"legacy").unwrap();
    let app = build_app_router(state.clone()).layer(axum::Extension(ConnectInfo(
        SocketAddr::from(([127, 0, 0, 1], 42000)),
    )));

    let initial_get = app
        .clone()
        .oneshot(
            Request::get("/uploads/canonical.bin")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    if initial_get.status() != StatusCode::OK {
        let status = initial_get.status();
        let body = axum::body::to_bytes(initial_get.into_body(), 4096)
            .await
            .unwrap();
        panic!(
            "upload GET returned {status}: {}",
            String::from_utf8_lossy(&body)
        );
    }
    assert_eq!(
        axum::body::to_bytes(initial_get.into_body(), 4096)
            .await
            .unwrap(),
        b"regional bytes".as_slice()
    );

    let head = app
        .clone()
        .oneshot(
            Request::head("/uploads/canonical.bin")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    if head.status() != StatusCode::OK {
        let status = head.status();
        let body = axum::body::to_bytes(head.into_body(), 4096).await.unwrap();
        panic!(
            "upload HEAD returned {status}: {}",
            String::from_utf8_lossy(&body)
        );
    }
    assert_eq!(head.headers()["cache-control"], "private, no-cache");
    let etag = head.headers()["etag"].clone();
    assert_eq!(head.headers()["content-length"], "14");
    assert!(axum::body::to_bytes(head.into_body(), 1024)
        .await
        .unwrap()
        .is_empty());
    let unchanged = app
        .clone()
        .oneshot(
            Request::get("/uploads/canonical.bin")
                .header("if-none-match", &etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unchanged.status(), StatusCode::NOT_MODIFIED);
    let legacy = app
        .clone()
        .oneshot(
            Request::head("/uploads/legacy.bin")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(legacy.status(), StatusCode::OK);
    assert_eq!(legacy.headers()["cache-control"], "private, no-store");
    assert!(!legacy.headers().contains_key("etag"));

    state
        .upload_registry
        .revoke_canonical("canonical.bin", state.wdb.engine(), 1)
        .await
        .unwrap();
    for method in ["HEAD", "GET"] {
        let denied = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri("/uploads/canonical.bin")
                    .header("if-none-match", &etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::GONE);
    }
}

#[tokio::test]
async fn legacy_roster_imports_once_and_database_wins_over_stale_sidecar() {
    use wabi_server::community_roster::{RosterEntry, RosterRole, RosterUpdate};
    use wabidb::projections::community_roster as projection;

    let tmp = tempfile::TempDir::new().unwrap();
    let sidecar = tmp.path().join("community_roster.json");
    std::fs::write(
        &sidecar,
        serde_json::json!({
            "schemaVersion": 1,
            "version": 1,
            "entries": [{"nodeId":"old","role":"authority","url":"https://old.example"}]
        })
        .to_string(),
    )
    .unwrap();
    let config = test_config(tmp.path());
    let state = AppState::new(config.clone()).await.unwrap();
    assert_eq!(state.community_roster.signed().unwrap().body.version, 1);
    assert!(state
        .wdb
        .engine()
        .projection_state()
        .get(projection::INDEX, projection::KEY)
        .is_some());
    state
        .community_roster
        .update_db(
            RosterUpdate {
                expected_version: 1,
                entries: vec![RosterEntry {
                    node_id: "new".into(),
                    role: RosterRole::Authority,
                    url: "https://new.example".into(),
                }],
            },
            state.wdb.engine(),
            1,
        )
        .await
        .unwrap();
    assert_eq!(state.community_roster.signed().unwrap().body.version, 2);
    assert_eq!(
        state
            .community_roster
            .update_db(
                RosterUpdate {
                    expected_version: 1,
                    entries: vec![RosterEntry {
                        node_id: "other".into(),
                        role: RosterRole::Authority,
                        url: "https://other.example".into(),
                    }],
                },
                state.wdb.engine(),
                1,
            )
            .await
            .unwrap_err(),
        wabi_server::community_roster::RosterError::Conflict
    );
    assert!(std::fs::read_to_string(&sidecar)
        .unwrap()
        .contains("old.example"));
    drop(state);

    let reopened = writer_drain::app_state(&config).await.unwrap();
    let restored = reopened.community_roster.signed().unwrap();
    assert_eq!(restored.body.version, 2);
    assert_eq!(restored.body.entries[0].url, "https://new.example");
    drop(reopened);

    std::fs::write(&sidecar, b"damaged legacy sidecar").unwrap();
    let reopened = writer_drain::app_state(&config).await.unwrap();
    assert_eq!(reopened.community_roster.signed().unwrap().body.version, 2);
}

#[tokio::test]
async fn concurrent_first_registrations_create_exactly_one_owner() {
    let (_tmp, app) = fresh_server().await;
    assert!(
        setup_required(&app).await,
        "fresh server must require setup"
    );

    let (a, b) = tokio::join!(
        app.clone().oneshot(register_request("alice")),
        app.clone().oneshot(register_request("bob")),
    );
    let responses = [a.unwrap(), b.unwrap()];
    let statuses = [responses[0].status(), responses[1].status()];
    let mut bodies = Vec::new();
    for response in responses {
        bodies.push(
            String::from_utf8_lossy(
                &axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap(),
            )
            .into_owned(),
        );
    }
    assert_eq!(
        statuses,
        [StatusCode::OK, StatusCode::CONFLICT],
        "exactly one concurrent first registration may succeed; got {statuses:?}: {bodies:?}"
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
    assert_eq!(
        later.status(),
        StatusCode::OK,
        "post-setup registration under the default open policy must succeed"
    );
}

#[tokio::test]
async fn new_member_welcome_resumes_and_completes_without_reception_channel() {
    use wabidb::engine::wabi_store::WabiStore;
    let tmp = tempfile::TempDir::new().unwrap();
    let state = Arc::new(AppState::new(test_config(tmp.path())).await.unwrap());
    let app = create_api_router(state.clone()).with_state(state.clone());
    let mut registration = register_request("owner");
    registration
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 42001))));
    let registered = app.clone().oneshot(registration).await.unwrap();
    let status = registered.status();
    let body = axum::body::to_bytes(registered.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let account: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let token = account["accessToken"].as_str().unwrap();
    let reception = || {
        Request::get("/server-center/reception")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    let pending = app.clone().oneshot(reception()).await.unwrap();
    assert_eq!(pending.status(), StatusCode::OK);
    let body = axum::body::to_bytes(pending.into_body(), usize::MAX)
        .await
        .unwrap();
    let guide: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(guide["welcomePending"], true);
    assert!(!state
        .wdb
        .list_channels(None)
        .await
        .unwrap()
        .iter()
        .any(|channel| channel.channel_kind == wabidb::domain::ChannelKind::Reception));
    let done = app
        .clone()
        .oneshot(
            Request::post("/server-center/reception/complete")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(done.status(), StatusCode::OK);
    let after = app.clone().oneshot(reception()).await.unwrap();
    let body = axum::body::to_bytes(after.into_body(), usize::MAX)
        .await
        .unwrap();
    let guide: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(guide["welcomePending"], false);
}

#[tokio::test]
async fn bootstrap_channels_preserve_configured_live_default_after_restart() {
    use wabidb::engine::wabi_store::WabiStore;
    let tmp = tempfile::TempDir::new().unwrap();
    let privacy = serde_json::json!({"privacy": {
        "defaultRetention":"live", "privateContentAutomation":false,
        "analyticsMode":"off", "externalProcessing":"none", "reportEvidencePreservation":"none"
    }});
    std::fs::write(tmp.path().join("server_center.json"), privacy.to_string()).unwrap();
    let config = test_config(tmp.path());
    let state = Arc::new(AppState::new(config.clone()).await.unwrap());
    let app = create_api_router(state.clone()).with_state(state.clone());
    assert_eq!(
        app.clone()
            .oneshot(register_request("owner"))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let channels = state.wdb.list_channels(None).await.unwrap();
    assert_eq!(channels.len(), 2);
    for channel in &channels {
        assert_eq!(
            state
                .channel_auto_delete_label
                .read()
                .await
                .get(&channel.channel_id)
                .map(String::as_str),
            Some("live")
        );
        assert_eq!(
            wabi_server::api::retention_policy::label(
                tmp.path().to_str().unwrap(),
                &channel.channel_id
            )
            .unwrap()
            .as_deref(),
            Some("live")
        );
    }
    drop(app);
    drop(state);
    let reopened = writer_drain::app_state(&config).await.unwrap();
    for channel in &channels {
        assert_eq!(
            reopened
                .channel_auto_delete_label
                .read()
                .await
                .get(&channel.channel_id)
                .map(String::as_str),
            Some("live")
        );
    }
}

#[tokio::test]
async fn damaged_bootstrap_defaults_do_not_claim_owner_or_create_account() {
    use wabidb::engine::wabi_store::WabiStore;
    let tmp = tempfile::TempDir::new().unwrap();
    let state = Arc::new(AppState::new(test_config(tmp.path())).await.unwrap());
    let app = create_api_router(state.clone()).with_state(state.clone());
    std::fs::write(tmp.path().join("server_center.json"), b"{broken").unwrap();
    assert_eq!(
        app.clone()
            .oneshot(register_request("owner"))
            .await
            .unwrap()
            .status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert!(setup_required(&app).await);
    assert!(state
        .wdb
        .get_user_by_username("owner")
        .await
        .unwrap()
        .is_none());
    assert!(state.wdb.list_channels(None).await.unwrap().is_empty());
}

const DESKTOP_BOOTSTRAP_TOKEN: &str = "private-desktop-bootstrap-capability-for-test";

async fn managed_server(data: &Path) -> (Arc<AppState>, axum::Router) {
    let state = Arc::new(
        AppState::new_with_desktop_bootstrap(
            test_config(data),
            Some(DESKTOP_BOOTSTRAP_TOKEN.into()),
        )
        .await
        .unwrap(),
    );
    let app = create_api_router(state.clone()).with_state(state.clone());
    (state, app)
}

async fn reopen_managed_server(data: &Path) -> (Arc<AppState>, axum::Router) {
    let state = Arc::new(
        writer_drain::retry(
            || {
                AppState::new_with_desktop_bootstrap(
                    test_config(data),
                    Some(DESKTOP_BOOTSTRAP_TOKEN.into()),
                )
            },
            writer_drain::is_already_running,
        )
        .await
        .unwrap(),
    );
    let app = create_api_router(state.clone()).with_state(state.clone());
    (state, app)
}

async fn json_response(response: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn api_request(path: &str, body: serde_json::Value, bearer: Option<&str>) -> Request<Body> {
    let mut builder = Request::post(path).header("content-type", "application/json");
    if let Some(token) = bearer {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let mut request = builder.body(Body::from(body.to_string())).unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 42001))));
    request
}

async fn managed_owner(app: &axum::Router) -> serde_json::Value {
    let mut request = api_request(
        "/auth/register",
        serde_json::json!({
            "username":"host-owner", "password":"password123", "communityName":"Family community",
        }),
        None,
    );
    request.headers_mut().insert(
        "x-wabi-bootstrap-token",
        DESKTOP_BOOTSTRAP_TOKEN.parse().unwrap(),
    );
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    json_response(response).await
}

#[tokio::test]
async fn admin_upload_revocation_commits_before_success_response() {
    use wabidb::projections::upload_revocations as projection;

    let tmp = tempfile::TempDir::new().unwrap();
    let (state, app) = managed_server(tmp.path()).await;
    let owner = managed_owner(&app).await;
    let token = owner["accessToken"].as_str().unwrap();
    let response = app
        .clone()
        .oneshot(api_request(
            "/admin/uploads/revoke",
            serde_json::json!({"filename":"private.bin"}),
            Some(token),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(state.upload_registry.is_revoked("private.bin").await);
    let event = state
        .wdb
        .engine()
        .projection_state()
        .get(projection::INDEX, b"private.bin")
        .expect("revocation event applied before API acknowledgement");
    assert_eq!(projection::decode(&event).unwrap().filename, "private.bin");
}

#[tokio::test]
async fn desktop_bootstrap_requires_private_capability_and_preserves_owner_after_reopen() {
    use wabidb::engine::wabi_store::WabiStore;
    let dir = tempfile::tempdir().unwrap();
    let (state, app) = managed_server(dir.path()).await;
    let response = app
        .clone()
        .oneshot(register_request("outsider"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(state.wdb.list_users().await.unwrap().is_empty());
    let mut wrong = register_request("outsider");
    wrong
        .headers_mut()
        .insert("x-wabi-bootstrap-token", "wrong-token".parse().unwrap());
    assert_eq!(
        app.clone().oneshot(wrong).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    let mut invite_claim = api_request(
        "/auth/register",
        serde_json::json!({
            "username":"outsider", "password":"password123", "inviteToken":"ab".repeat(32),
        }),
        None,
    );
    invite_claim.headers_mut().insert(
        "x-wabi-bootstrap-token",
        DESKTOP_BOOTSTRAP_TOKEN.parse().unwrap(),
    );
    assert_eq!(
        app.clone().oneshot(invite_claim).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    let mut guest = api_request("/auth/guest", serde_json::json!({"username":"guest"}), None);
    guest.extensions_mut().insert(axum::extract::ConnectInfo(
        "127.0.0.1:4000".parse::<std::net::SocketAddr>().unwrap(),
    ));
    assert_eq!(
        app.clone().oneshot(guest).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    let owner = managed_owner(&app).await;
    assert!(!setup_required(&app).await);
    assert_eq!(
        *state.owner_user_id.read().await,
        owner["user"]["id"].as_i64()
    );
    let policy: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("admin_policies.json")).unwrap())
            .unwrap();
    assert_eq!(
        policy["frontend_app_metadata"]["displayName"],
        "Family community"
    );
    assert_eq!(
        app.clone()
            .oneshot(register_request("uninvited"))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let key = std::fs::read(dir.path().join("wabidb/root_key")).unwrap();
    drop(app);
    drop(state);
    let (reopened, app) = reopen_managed_server(dir.path()).await;
    assert!(!setup_required(&app).await);
    assert_eq!(
        *reopened.owner_user_id.read().await,
        owner["user"]["id"].as_i64()
    );
    assert_eq!(
        std::fs::read(dir.path().join("wabidb/root_key")).unwrap(),
        key
    );
    assert_eq!(reopened.wdb.list_channels(None).await.unwrap().len(), 2);
}

#[tokio::test]
async fn desktop_invites_are_owner_only_one_use_and_revoke_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (state, app) = managed_server(dir.path()).await;
    let create = || api_request("/invites", serde_json::json!({"expiresInHours":24}), None);
    assert_eq!(
        app.clone().oneshot(create()).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    let owner = managed_owner(&app).await;
    let owner_token = owner["accessToken"].as_str().unwrap();
    let response = app
        .clone()
        .oneshot(api_request(
            "/invites",
            serde_json::json!({"expiresInHours":24}),
            Some(owner_token),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let grant = json_response(response).await;
    let token = grant["token"].as_str().unwrap();
    let (a, b) = tokio::join!(
        app.clone().oneshot(api_request(
            "/auth/register",
            serde_json::json!({"username":"alice","password":"password123","inviteToken":token}),
            None
        )),
        app.clone().oneshot(api_request(
            "/auth/register",
            serde_json::json!({"username":"bob","password":"password123","inviteToken":token}),
            None
        )),
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    let (accepted, rejected) = if a.status() == StatusCode::OK {
        (a, b)
    } else {
        (b, a)
    };
    assert_eq!(accepted.status(), StatusCode::OK);
    assert_eq!(rejected.status(), StatusCode::FORBIDDEN);
    let member = json_response(accepted).await;
    assert_eq!(
        app.clone()
            .oneshot(api_request(
                "/invites",
                serde_json::json!({"expiresInHours":24}),
                member["accessToken"].as_str()
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let new_grant = json_response(
        app.clone()
            .oneshot(api_request(
                "/invites",
                serde_json::json!({"expiresInHours":1}),
                Some(owner_token),
            ))
            .await
            .unwrap(),
    )
    .await;
    let revoke = Request::delete(format!("/invites/{}", new_grant["id"].as_str().unwrap()))
        .header("authorization", format!("Bearer {owner_token}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.clone().oneshot(revoke).await.unwrap().status(),
        StatusCode::OK
    );
    drop(app);
    drop(state);
    let (_state, app) = reopen_managed_server(dir.path()).await;
    for invalid in [token, new_grant["token"].as_str().unwrap()] {
        assert_eq!(app.clone().oneshot(api_request("/auth/register", serde_json::json!({"username":"charlie","password":"password123","inviteToken":invalid}), None)).await.unwrap().status(), StatusCode::FORBIDDEN);
    }
    let persisted = std::fs::read_to_string(dir.path().join("join-invites-v1.json")).unwrap();
    assert!(!persisted.contains(token));
}

#[tokio::test]
async fn damaged_admission_policy_never_reopens_registration() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(test_config(dir.path())).await.unwrap());
    let app = create_api_router(state.clone()).with_state(state.clone());
    assert_eq!(
        app.clone()
            .oneshot(register_request("owner"))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    for bytes in [
        "{broken",
        "[]",
        r#"{"auth_policy":{"allowRegister":"false"}}"#,
        r#"{"auth_policy":{"mode":"unknown"}}"#,
    ] {
        std::fs::write(dir.path().join("admin_policies.json"), bytes).unwrap();
        assert_eq!(
            app.clone()
                .oneshot(register_request("outsider"))
                .await
                .unwrap()
                .status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("admin_policies.json")).unwrap(),
            bytes
        );
    }
}

#[tokio::test]
async fn incomplete_existing_database_is_preserved_without_replacement_key() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path());
    let state = AppState::new(config.clone()).await.unwrap();
    drop(state);
    let key_path = dir.path().join("wabidb/root_key");
    let original_key = std::fs::read(&key_path).unwrap();
    std::fs::remove_file(&key_path).unwrap();
    assert!(AppState::new(config.clone()).await.is_err());
    assert!(!key_path.exists());
    std::fs::write(&key_path, &original_key).unwrap();
    let manifest = dir.path().join("wabidb/storage-manifest.json");
    let original_manifest = std::fs::read(&manifest).unwrap();
    std::fs::remove_file(&manifest).unwrap();
    assert!(AppState::new(config.clone()).await.is_err());
    assert!(!manifest.exists());
    assert_eq!(std::fs::read(&key_path).unwrap(), original_key);
    std::fs::write(&manifest, original_manifest).unwrap();
    writer_drain::app_state(&config).await.unwrap();
}

#[tokio::test]
async fn fenced_authority_refuses_to_boot_or_serve_sidecar_routes() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path());
    let state = AppState::new(config.clone()).await.unwrap();
    std::fs::write(dir.path().join("jwt_secret"), config.jwt_secret.as_bytes()).unwrap();
    drop(state);
    wait_for_writer_drain(dir.path()).await;
    let fenced = std::process::Command::new(env!("CARGO_BIN_EXE_wabi-instance-snapshot"))
        .arg("fence-stopped")
        .arg("--data-dir")
        .arg(dir.path())
        .output()
        .unwrap();
    assert!(
        fenced.status.success(),
        "{}",
        String::from_utf8_lossy(&fenced.stderr)
    );
    assert!(dir.path().join("wabidb/writer-fenced-v1").exists());
    let error = match AppState::new(config).await {
        Ok(_) => panic!("fenced Authority unexpectedly booted"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("writer-fenced"), "{error}");
    std::fs::remove_file(dir.path().join("jwt_secret")).unwrap();
    let _ = std::fs::remove_dir_all(dir.path().join("uploads"));
    let logs = tempfile::tempdir().unwrap();
    let process = std::process::Command::new(env!("CARGO_BIN_EXE_wabi-server"))
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg("0")
        .arg("--data-dir")
        .arg(dir.path())
        .env("WABI_SERVER_ROLE", "authority")
        .env_remove("WABI_PURGE_ORPHANS")
        .env("WABI_LOG_DIR", logs.path())
        .output()
        .unwrap();
    assert!(!process.status.success());
    assert!(String::from_utf8_lossy(&process.stderr).contains("writer-fenced"));
    assert!(!dir.path().join("jwt_secret").exists());
    assert!(!dir.path().join("uploads").exists());
}

#[tokio::test]
async fn encrypted_stopped_move_preserves_community_id_and_retires_original() {
    use wabi_server::community_roster::{RosterEntry, RosterRole, RosterUpdate};
    use wabidb::engine::wabi_store::WabiStore;

    let root = tempfile::tempdir().unwrap();
    let old_data = root.path().join("old-data");
    let old_uploads = old_data.join("uploads");
    std::fs::create_dir_all(&old_uploads).unwrap();
    let old_config = test_config(&old_data);
    let state = AppState::new(old_config.clone()).await.unwrap();
    let community_id = state.community_roster.community_id().to_string();
    state
        .community_roster
        .update_db(
            RosterUpdate {
                expected_version: 0,
                entries: vec![
                    RosterEntry {
                        node_id: "old".into(),
                        role: RosterRole::Authority,
                        url: "https://old.example".into(),
                    },
                    RosterEntry {
                        node_id: "new".into(),
                        role: RosterRole::Anchor,
                        url: "https://new.example".into(),
                    },
                ],
            },
            state.wdb.engine(),
            0,
        )
        .await
        .unwrap();
    std::fs::write(
        old_data.join("jwt_secret"),
        old_config.jwt_secret.as_bytes(),
    )
    .unwrap();
    drop(state);
    wait_for_writer_drain(&old_data).await;

    let snapshot_binary = env!("CARGO_BIN_EXE_wabi-instance-snapshot");
    let identity = root.path().join("recovery.agekey");
    let keygen = std::process::Command::new(snapshot_binary)
        .arg("keygen")
        .arg("--identity-file")
        .arg(&identity)
        .output()
        .unwrap();
    assert!(
        keygen.status.success(),
        "{}",
        String::from_utf8_lossy(&keygen.stderr)
    );
    let recipient = String::from_utf8(keygen.stdout)
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix("Recipient: ").map(str::to_string))
        .unwrap();
    let retired = std::process::Command::new(snapshot_binary)
        .arg("fence-stopped")
        .arg("--data-dir")
        .arg(&old_data)
        .output()
        .unwrap();
    assert!(
        retired.status.success(),
        "{}",
        String::from_utf8_lossy(&retired.stderr)
    );
    let archive = root.path().join("handoff.age");
    let exported = std::process::Command::new(snapshot_binary)
        .arg("export")
        .arg("--data-dir")
        .arg(&old_data)
        .arg("--uploads-dir")
        .arg(&old_uploads)
        .arg("--recipient")
        .arg(&recipient)
        .arg("--output")
        .arg(&archive)
        .output()
        .unwrap();
    assert!(
        exported.status.success(),
        "{}",
        String::from_utf8_lossy(&exported.stderr)
    );
    let restored_root = root.path().join("new-host");
    let restored = std::process::Command::new(snapshot_binary)
        .arg("restore")
        .arg("--input")
        .arg(&archive)
        .arg("--identity-file")
        .arg(&identity)
        .arg("--target-root")
        .arg(&restored_root)
        .arg("--controlled-move")
        .output()
        .unwrap();
    assert!(
        restored.status.success(),
        "{}",
        String::from_utf8_lossy(&restored.stderr)
    );
    assert!(restored_root
        .join("data/wabidb/activation-pending-v1")
        .exists());
    let premature = match AppState::new(test_config(&restored_root.join("data"))).await {
        Ok(_) => panic!("controlled-move restore booted before receipt activation"),
        Err(error) => error,
    };
    assert!(
        premature.to_string().contains("activation-pending"),
        "{premature}"
    );
    let pending_data = restored_root.join("data");
    std::fs::remove_file(pending_data.join("jwt_secret")).unwrap();
    let _ = std::fs::remove_dir_all(pending_data.join("uploads"));
    let logs = tempfile::tempdir().unwrap();
    let process = std::process::Command::new(env!("CARGO_BIN_EXE_wabi-server"))
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg("0")
        .arg("--data-dir")
        .arg(&pending_data)
        .env("WABI_SERVER_ROLE", "authority")
        .env("WABI_LOG_DIR", logs.path())
        .output()
        .unwrap();
    assert!(!process.status.success());
    assert!(String::from_utf8_lossy(&process.stderr).contains("activation-pending"));
    assert!(!pending_data.join("jwt_secret").exists());
    assert!(!pending_data.join("uploads").exists());
    std::fs::write(
        pending_data.join("jwt_secret"),
        old_config.jwt_secret.as_bytes(),
    )
    .unwrap();
    std::fs::create_dir_all(pending_data.join("uploads")).unwrap();
    let receipt = root.path().join("fence-receipt.json");
    let fenced = std::process::Command::new(snapshot_binary)
        .arg("fence-stopped")
        .arg("--data-dir")
        .arg(&old_data)
        .arg("--archive")
        .arg(&archive)
        .arg("--receipt")
        .arg(&receipt)
        .output()
        .unwrap();
    assert!(
        fenced.status.success(),
        "{}",
        String::from_utf8_lossy(&fenced.stderr)
    );
    assert!(AppState::new(old_config).await.is_err());
    let activated = std::process::Command::new(snapshot_binary)
        .arg("activate-restored")
        .arg("--target-root")
        .arg(&restored_root)
        .arg("--receipt")
        .arg(&receipt)
        .output()
        .unwrap();
    assert!(
        activated.status.success(),
        "{}",
        String::from_utf8_lossy(&activated.stderr)
    );
    assert!(!restored_root
        .join("data/wabidb/activation-pending-v1")
        .exists());

    let replacement = AppState::new(test_config(&restored_root.join("data")))
        .await
        .unwrap();
    assert_eq!(replacement.community_roster.community_id(), community_id);
    assert_eq!(
        replacement.community_roster.signed().unwrap().body.version,
        1
    );
    assert!(!restored_root.join("data/wabidb/writer-fenced-v1").exists());
    replacement
        .community_roster
        .update_db(
            RosterUpdate {
                expected_version: 1,
                entries: vec![RosterEntry {
                    node_id: "new".into(),
                    role: RosterRole::Authority,
                    url: "https://new.example".into(),
                }],
            },
            replacement.wdb.engine(),
            0,
        )
        .await
        .unwrap();
    assert_eq!(
        replacement.community_roster.signed().unwrap().body.version,
        2
    );
    assert_eq!(replacement.community_roster.community_id(), community_id);
    replacement
        .wdb
        .create_user("after-move", None, "test-hash")
        .await
        .unwrap();

    // A retired site rejoins from the new Authority's complete stopped state,
    // never by removing the fence from its original data tree.
    drop(replacement);
    let new_data = restored_root.join("data");
    wait_for_writer_drain(&new_data).await;
    let reseed_archive = root.path().join("reseed.age");
    let exported = std::process::Command::new(snapshot_binary)
        .arg("export")
        .arg("--data-dir")
        .arg(&new_data)
        .arg("--uploads-dir")
        .arg(new_data.join("uploads"))
        .arg("--recipient")
        .arg(&recipient)
        .arg("--output")
        .arg(&reseed_archive)
        .output()
        .unwrap();
    assert!(
        exported.status.success(),
        "{}",
        String::from_utf8_lossy(&exported.stderr)
    );
    let rejoined_root = root.path().join("old-host-reseeded");
    let restored = std::process::Command::new(snapshot_binary)
        .arg("restore")
        .arg("--input")
        .arg(&reseed_archive)
        .arg("--identity-file")
        .arg(&identity)
        .arg("--target-root")
        .arg(&rejoined_root)
        .arg("--passive-replica")
        .output()
        .unwrap();
    assert!(
        restored.status.success(),
        "{}",
        String::from_utf8_lossy(&restored.stderr)
    );
    let rejoined_data = rejoined_root.join("data");
    assert!(old_data.join("wabidb/writer-fenced-v1").exists());
    assert!(rejoined_data.join("wabidb/writer-fenced-v1").exists());
    assert_eq!(
        std::fs::read(old_data.join("wabidb/root_key")).unwrap(),
        std::fs::read(rejoined_data.join("wabidb/root_key")).unwrap()
    );
    let old_boot = match AppState::new(test_config(&old_data)).await {
        Ok(_) => panic!("retired Authority started from its fenced tree"),
        Err(error) => error,
    };
    assert!(old_boot.to_string().contains("writer-fenced"));
    let rejoined_boot = match AppState::new(test_config(&rejoined_data)).await {
        Ok(_) => panic!("reseeded passive tree started as an Authority"),
        Err(error) => error,
    };
    assert!(rejoined_boot.to_string().contains("writer-fenced"));

    let key_hex = std::fs::read_to_string(rejoined_data.join("wabidb/root_key")).unwrap();
    let key: [u8; 32] = hex::decode(key_hex.trim()).unwrap().try_into().unwrap();
    let passive = wabidb::engine::WabiDbEngine::open(wabidb::engine::WabiDbConfig::new(
        rejoined_data.join("wabidb"),
        wabidb::crypto::bootstrap::BootstrapSource::Provided(key),
    ))
    .await
    .unwrap();
    assert!(passive.durable_writer_fenced());
    let mut after_move_user = false;
    passive.projection_state().for_each("users", |_, value| {
        if let Ok(user) = wabidb::projections::users::decode_record(value) {
            after_move_user |= user.username == "after-move";
        }
    });
    assert!(
        after_move_user,
        "reseeded passive tree lost the new Authority's write"
    );
}
