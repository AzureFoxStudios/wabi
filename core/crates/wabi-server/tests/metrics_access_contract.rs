//! `/metrics` access contract against the real application router.
//!
//! INSTALL.md promises that `/metrics` is admin-gated unless the operator sets
//! `WABI_METRICS_PUBLIC`. This file pins that promise:
//! - anonymous and member requests are refused by default;
//! - an admin (same check as the admin APIs) can read it;
//! - `WABI_METRICS_TOKEN` lets a scraper in with `Authorization: Bearer`;
//! - `WABI_METRICS_PUBLIC=1` opens it to everyone;
//! - `/health`, `/livez` and `/readyz` stay public and carry nothing personal;
//! - no metric line carries a per-person or per-conversation label.
//!
//! The env switches are read when the router is built, so every scenario that
//! touches them holds `ENV_LOCK` while it builds its router.

use std::path::Path;
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::Router;
use tokio::sync::Mutex;
use tower::ServiceExt;

use wabi_server::app_router::build_app_router;
use wabi_server::auth_extractor::JwtClaims;
use wabi_server::config::{LoreAddonConfig, ServerConfig, ServerRole};
use wabi_server::state::AppState;
use wabidb::engine::wabi_store::WabiStore;

static ENV_LOCK: Mutex<()> = Mutex::const_new(());

async fn add_connect_info(
    mut req: Request<Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let addr: std::net::SocketAddr = "127.0.0.1:11111".parse().unwrap();
    req.extensions_mut().insert(axum::extract::connect_info::ConnectInfo(addr));
    next.run(req).await
}

async fn state(path: &Path) -> Arc<AppState> {
    Arc::new(
        AppState::new(ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: path.to_string_lossy().into_owned(),
            uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
            jwt_secret: "metrics-access-contract-only".into(),
            turn_enabled: false,
            turn_uri: None,
            turn_secret: None,
            node_id: "test".into(),
            is_primary: true,
            server_role: ServerRole::Authority,
            authority_url: None,
            admin_user_ids: vec![],
            blacklist_file: path.join("blacklist").to_string_lossy().into_owned(),
            max_body_size: None,
            mesh_enabled: false,
            mesh_peers: vec![],
            lore: LoreAddonConfig::default(),
        })
        .await
        .unwrap(),
    )
}

fn token(state: &AppState, uid: u64) -> String {
    let now = chrono::Utc::now().timestamp();
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &JwtClaims {
            sub: uid.to_string(),
            username: format!("user-{uid}"),
            is_guest: false,
            exp: now + 3600,
            iat: now,
            jti: uuid::Uuid::new_v4().to_string(),
            stepup: false,
            token_type: "access".into(),
        },
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .unwrap()
}

/// Owner (admin) and plain member.
async fn seed(state: &AppState) -> (u64, u64) {
    let owner = state.wdb.create_user("owner", None, "registered-test-hash").await.unwrap();
    let member = state.wdb.create_user("member", None, "registered-test-hash").await.unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    (owner, member)
}

/// Build the router with the given metrics env switches. Caller holds ENV_LOCK.
fn router_with_env(state: &Arc<AppState>, public: Option<&str>, scrape_token: Option<&str>) -> Router {
    match public {
        Some(v) => std::env::set_var("WABI_METRICS_PUBLIC", v),
        None => std::env::remove_var("WABI_METRICS_PUBLIC"),
    }
    match scrape_token {
        Some(v) => std::env::set_var("WABI_METRICS_TOKEN", v),
        None => std::env::remove_var("WABI_METRICS_TOKEN"),
    }
    let app = build_app_router(state.clone()).layer(axum::middleware::from_fn(add_connect_info));
    std::env::remove_var("WABI_METRICS_PUBLIC");
    std::env::remove_var("WABI_METRICS_TOKEN");
    app
}

async fn get(app: &Router, path: &str, bearer: Option<&str>) -> (StatusCode, String) {
    let mut req = Request::get(path);
    if let Some(b) = bearer {
        req = req.header("authorization", format!("Bearer {b}"));
    }
    let resp = app.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    let status = resp.status();
    let body = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    (status, String::from_utf8_lossy(&body).into_owned())
}

#[tokio::test]
async fn metrics_is_admin_only_by_default() {
    let dir = tempfile::tempdir().unwrap();
    let state = state(dir.path()).await;
    let (owner, member) = seed(&state).await;
    let app = {
        let _g = ENV_LOCK.lock().await;
        router_with_env(&state, None, None)
    };

    let (status, body) = get(&app, "/metrics", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "anonymous must be refused: {body}");
    assert!(!body.contains("wabi_http_requests_total"));

    let (status, body) = get(&app, "/metrics", Some(&token(&state, member))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "member must be refused: {body}");
    assert!(!body.contains("wabi_http_requests_total"));

    let (status, body) = get(&app, "/metrics", Some("not-a-jwt")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "garbage bearer must be refused: {body}");

    let (status, body) = get(&app, "/metrics", Some(&token(&state, owner))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("wabi_http_requests_total"), "admin sees metrics: {body}");
}

#[tokio::test]
async fn scrape_token_admits_a_scraper_and_nothing_else() {
    let dir = tempfile::tempdir().unwrap();
    let state = state(dir.path()).await;
    let (owner, member) = seed(&state).await;
    let secret = "scrape-secret-0123456789abcdef";
    let app = {
        let _g = ENV_LOCK.lock().await;
        router_with_env(&state, None, Some(secret))
    };

    let (status, body) = get(&app, "/metrics", Some(secret)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("wabi_http_requests_total"));

    let (status, _) = get(&app, "/metrics", Some("scrape-secret-0123456789abcdeX")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "wrong token refused");
    let (status, _) = get(&app, "/metrics", Some("scrape-secret")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "prefix of token refused");
    let (status, _) = get(&app, "/metrics", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = get(&app, "/metrics", Some(&token(&state, member))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // An admin still gets in when a scrape token is configured.
    let (status, _) = get(&app, "/metrics", Some(&token(&state, owner))).await;
    assert_eq!(status, StatusCode::OK);

    // The scrape token is not an account credential anywhere else.
    let (status, _) = get(&app, "/api/admin/stats", Some(secret)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "scrape token must not open admin APIs");
}

#[tokio::test]
async fn public_switch_opens_metrics_to_everyone() {
    let dir = tempfile::tempdir().unwrap();
    let state = state(dir.path()).await;
    for value in ["1", "true", "TRUE", "yes"] {
        let app = {
            let _g = ENV_LOCK.lock().await;
            router_with_env(&state, Some(value), None)
        };
        let (status, body) = get(&app, "/metrics", None).await;
        assert_eq!(status, StatusCode::OK, "WABI_METRICS_PUBLIC={value}");
        assert!(body.contains("wabi_http_requests_total"));
    }
    // Anything else keeps the gate closed (fail closed on typos).
    for value in ["0", "false", "", "no", "ture"] {
        let app = {
            let _g = ENV_LOCK.lock().await;
            router_with_env(&state, Some(value), None)
        };
        let (status, _) = get(&app, "/metrics", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "WABI_METRICS_PUBLIC={value:?}");
    }
}

#[tokio::test]
async fn health_probes_stay_public_and_impersonal() {
    let dir = tempfile::tempdir().unwrap();
    let state = state(dir.path()).await;
    seed(&state).await;
    let app = {
        let _g = ENV_LOCK.lock().await;
        router_with_env(&state, None, None)
    };
    for (path, keys) in [
        ("/health", &["role", "service", "status", "timestamp", "version"][..]),
        ("/livez", &["service", "status"][..]),
        ("/readyz", &["engine", "status"][..]),
    ] {
        let (status, body) = get(&app, path, None).await;
        assert_eq!(status, StatusCode::OK, "{path} public");
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let mut got: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        got.sort();
        assert_eq!(got, keys, "{path} exposes exactly these fields");
        assert!(!body.contains("owner") && !body.contains("member"), "{path}: {body}");
    }
}

#[tokio::test]
async fn metric_lines_carry_no_personal_or_conversation_labels() {
    let dir = tempfile::tempdir().unwrap();
    let state = state(dir.path()).await;
    let (owner, member) = seed(&state).await;
    state
        .wdb
        .create_channel("secret-plans", wabidb::domain::ChannelKind::Text, owner, false)
        .await
        .unwrap();
    let app = {
        let _g = ENV_LOCK.lock().await;
        router_with_env(&state, None, None)
    };
    // Generate some traffic as identifiable users first.
    let _ = get(&app, "/api/channels", Some(&token(&state, member))).await;
    let _ = get(&app, "/api/users/me", Some(&token(&state, owner))).await;

    let (status, body) = get(&app, "/metrics", Some(&token(&state, owner))).await;
    assert_eq!(status, StatusCode::OK);
    let allowed_labels = ["service", "le"];
    for line in body.lines().filter(|l| !l.starts_with('#') && !l.is_empty()) {
        if let Some(open) = line.find('{') {
            let close = line.find('}').unwrap();
            for pair in line[open + 1..close].split(',') {
                let key = pair.split('=').next().unwrap();
                assert!(allowed_labels.contains(&key), "unexpected label {key:?} in {line}");
            }
        }
    }
    for needle in ["owner", "member", "secret-plans", "127.0.0.1", "user", "channel"] {
        assert!(!body.contains(needle), "metrics mention {needle:?}:\n{body}");
    }
}
