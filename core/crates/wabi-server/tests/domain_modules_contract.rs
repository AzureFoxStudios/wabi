//! A domain module defined entirely in this file plugs its records and
//! routes into the production API router and a real WabiDB, without any
//! engine or router source naming it.
use std::{path::Path, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{Method, Request, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use tower::ServiceExt;
use wabi_server::{
    api::routes::create_api_router,
    auth_extractor::{AuthUser, JwtClaims},
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    domain_modules::{DomainContext, DomainModule},
    error::AppError,
    state::AppState,
};
use wabidb::domain_modules::{DomainEvent, DomainIndexes, DomainProjection};
use wabidb::engine::wabi_store::WabiStore;
use wabidb::projections::handler::DurableEvent;

// ───────── the module: running totals per name ─────────

const ADDED: &str = "tally.added";

struct Totals;

impl DomainProjection for Totals {
    fn apply(&self, event: &DurableEvent, indexes: &DomainIndexes<'_>) -> wabidb::error::Result<()> {
        let body: Value = serde_json::from_slice(&event.payload).unwrap_or_default();
        let (Some(name), Some(amount)) = (body["name"].as_str(), body["amount"].as_u64()) else {
            return Ok(());
        };
        let before = indexes
            .get("totals", name.as_bytes())
            .map_or(0, |bytes| u64::from_be_bytes(bytes.try_into().unwrap()));
        indexes.put("totals", name.as_bytes().to_vec(), (before + amount).to_be_bytes().to_vec());
        Ok(())
    }
}

async fn add(
    State(context): State<DomainContext>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    let name = body["name"].as_str().ok_or_else(|| AppError::BadRequest("name is required".into()))?;
    let event = DomainEvent {
        stream_id: format!("tally.{name}"),
        event_type: ADDED.into(),
        payload: serde_json::to_vec(&json!({"name": name, "amount": body["amount"], "by": user.user_id})).unwrap(),
    };
    let outcome = context.write(&user, "add", None, vec![event]).await?;
    Ok(Json(json!({"commitSeq": outcome.commit_seq})))
}

async fn totals(State(context): State<DomainContext>, _user: AuthUser) -> Result<Json<Value>, AppError> {
    let rows: serde_json::Map<String, Value> = context
        .reader()?
        .scan_prefix("totals", b"")
        .into_iter()
        .map(|(k, v)| (String::from_utf8(k).unwrap(), json!(u64::from_be_bytes(v.try_into().unwrap()))))
        .collect();
    Ok(Json(Value::Object(rows)))
}

fn tally() -> DomainModule {
    DomainModule {
        engine: wabidb::domain_modules::DomainModule {
            id: "tally",
            version: 1,
            event_types: &[ADDED],
            projection: Arc::new(Totals),
        },
        routes: Arc::new(|context| {
            Router::new()
                .route("/add", post(add))
                .route("/totals", get(totals))
                .with_state(context)
        }),
    }
}

// ───────── harness ─────────

fn server_config(path: &Path) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: path.to_string_lossy().into_owned(),
        uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "domain-module-test-only".into(),
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
    }
}

/// Open the server, waiting for a just-dropped one to release the directory.
async fn server(path: &Path, modules: Vec<DomainModule>) -> Arc<AppState> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        match AppState::new_with_modules(server_config(path), modules.clone()).await {
            Ok(state) => return Arc::new(state),
            Err(error)
                if error
                    .downcast_ref::<wabidb::error::WabiError>()
                    .is_some_and(|error| matches!(error, wabidb::error::WabiError::AlreadyRunning))
                    && tokio::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            Err(error) => panic!("could not open the server: {error:#}"),
        }
    }
}

fn app(state: &Arc<AppState>) -> Router {
    Router::new().nest("/api", create_api_router(state.clone())).with_state(state.clone())
}

fn jwt(state: &AppState, uid: u64) -> String {
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

async fn request(app: &Router, method: Method, path: &str, token: &str, body: Value) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(path).header("content-type", "application/json");
    if !token.is_empty() {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    let res = app.clone().oneshot(req.body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))))
}

// ───────── tests ─────────

#[tokio::test]
async fn a_module_serves_its_routes_and_keeps_its_records_across_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path(), vec![tally()]).await;
    let alice = state.wdb.create_user("Alice", None, "test-fixture-only").await.unwrap();
    let token = jwt(&state, alice);
    let router = app(&state);

    // The ordinary extractor guards the module's routes.
    let (status, _) = request(&router, Method::POST, "/api/domains/tally/add", "", json!({"name": "a", "amount": 5})).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = request(&router, Method::GET, "/api/domains/tally/totals", "", json!(null)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    for (name, amount) in [("a", 5), ("b", 7), ("a", 1)] {
        let (status, body) =
            request(&router, Method::POST, "/api/domains/tally/add", &token, json!({"name": name, "amount": amount})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["commitSeq"].as_u64().unwrap() > 0);
    }
    // A write is readable as soon as it has returned.
    let (status, body) = request(&router, Method::GET, "/api/domains/tally/totals", &token, json!(null)).await;
    assert_eq!((status, body), (StatusCode::OK, json!({"a": 6, "b": 7})));

    // The module's own refusals come back as client errors.
    let (status, _) = request(&router, Method::POST, "/api/domains/tally/add", &token, json!({"amount": 5})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) =
        request(&router, Method::POST, "/api/domains/tally/add", &token, json!({"name": "Not/Allowed", "amount": 5})).await;
    assert!(status.is_client_error(), "{status}");

    // Core routes are where they were.
    let (status, _) = request(&router, Method::GET, "/api/setup/status", "", json!(null)).await;
    assert_eq!(status, StatusCode::OK);

    drop(router);
    drop(state);
    let state = server(dir.path(), vec![tally()]).await;
    let (status, body) =
        request(&app(&state), Method::GET, "/api/domains/tally/totals", &jwt(&state, alice), json!(null)).await;
    assert_eq!((status, body), (StatusCode::OK, json!({"a": 6, "b": 7})));
}

#[tokio::test]
async fn a_caller_whose_account_is_gone_cannot_write() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path(), vec![tally()]).await;
    let token = jwt(&state, 424_242);
    let (status, _) =
        request(&app(&state), Method::POST, "/api/domains/tally/add", &token, json!({"name": "a", "amount": 5})).await;
    assert!(matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN), "{status}");
    let alice = state.wdb.create_user("Alice", None, "test-fixture-only").await.unwrap();
    let (_, body) =
        request(&app(&state), Method::GET, "/api/domains/tally/totals", &jwt(&state, alice), json!(null)).await;
    assert_eq!(body, json!({}));
}

#[tokio::test]
async fn the_stock_server_has_no_domain_routes_and_keeps_a_module_s_events() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path(), vec![tally()]).await;
    let alice = state.wdb.create_user("Alice", None, "test-fixture-only").await.unwrap();
    let (status, _) = request(
        &app(&state),
        Method::POST,
        "/api/domains/tally/add",
        &jwt(&state, alice),
        json!({"name": "a", "amount": 5}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    drop(state);

    // The same directory under a server built without the module.
    let state = Arc::new({
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            match AppState::new(server_config(dir.path())).await {
                Ok(state) => break state,
                Err(_) if tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await
                }
                Err(error) => panic!("{error:#}"),
            }
        }
    });
    let token = jwt(&state, alice);
    let (status, _) = request(&app(&state), Method::GET, "/api/domains/tally/totals", &token, json!(null)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = request(&app(&state), Method::GET, "/api/setup/status", "", json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    drop(state);

    // And back: nothing was lost.
    let state = server(dir.path(), vec![tally()]).await;
    let (_, body) =
        request(&app(&state), Method::GET, "/api/domains/tally/totals", &jwt(&state, alice), json!(null)).await;
    assert_eq!(body, json!({"a": 5}));
}
