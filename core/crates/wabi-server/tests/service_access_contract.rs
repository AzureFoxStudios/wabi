//! Service role persistence, independent authorization gates and real TCP traffic.
use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use std::future::IntoFuture;
use std::{path::Path, sync::Arc, time::Duration};
use tower::ServiceExt;
use wabi_server::{
    api::routes::create_api_router,
    auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
};
use wabidb::engine::wabi_store::WabiStore;

async fn server(path: &Path) -> Arc<AppState> {
    configured_server(path, vec![]).await
}

async fn configured_server(path: &Path, admin_user_ids: Vec<i64>) -> Arc<AppState> {
    Arc::new(
        AppState::new(ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: path.to_string_lossy().into_owned(),
            uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
            jwt_secret: "admin-role-contract-only".into(),
            turn_enabled: false,
            turn_uri: None,
            turn_secret: None,
            node_id: "test".into(),
            is_primary: true,
            server_role: ServerRole::Authority,
            authority_url: None,
            admin_user_ids,
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

fn router(state: &Arc<AppState>) -> Router {
    create_api_router(state.clone())
        .with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()))
}

async fn seed(state: &AppState) -> (u64, u64, u64) {
    let owner = state
        .wdb
        .create_user("owner", None, "registered-test-hash")
        .await
        .unwrap();
    let member = state
        .wdb
        .create_user("member", None, "registered-test-hash")
        .await
        .unwrap();
    let guest = state.wdb.create_user("guest", None, "").await.unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    (owner, member, guest)
}

async fn request(
    app: &Router,
    method: Method,
    path: &str,
    credential: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = credential {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let data = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&data)
            .unwrap_or_else(|_| json!({"raw":String::from_utf8_lossy(&data)})),
    )
}
async fn catalog(app: &Router, token: &str) -> Value {
    let (status, data) = request(
        app,
        Method::GET,
        "/admin/service-access",
        Some(token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{data}");
    data
}
async fn save(app: &Router, token: &str, data: &Value) -> (StatusCode, Value) {
    request(
        app,
        Method::PUT,
        "/admin/service-access",
        Some(token),
        json!({"revision":data["access"]["revision"],"roles":data["access"]["roles"]}),
    )
    .await
}
fn register(dir: &Path, address: std::net::SocketAddr, exposed: bool) {
    std::fs::write(dir.join("service_endpoints.json"), json!([
        {"id":"printer","name":"Office printer","kind":"printing","address":address.to_string(),"exposed":exposed},
        {"id":"minecraft","name":"Minecraft","kind":"game","address":address.to_string(),"exposed":true},
        {"id":"future","name":"Future service","kind":"anything","address":address.to_string(),"exposed":true}
    ]).to_string()).unwrap();
}
fn custom(data: &mut Value, uid: u64) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    data["access"]["roles"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":id,"name":"Print team","members":[uid],"services":["printer"]}));
    id
}
#[tokio::test]
async fn roles_are_separate_from_admin_and_device_admission() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, member, guest) = seed(&state).await;
    let app = router(&state);
    register(dir.path(), "127.0.0.1:9100".parse().unwrap(), true);
    let admin = token(&state, owner);
    let ordinary = token(&state, member);
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/admin/service-access",
            None,
            Value::Null
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    for uid in [member, guest] {
        assert_eq!(
            request(
                &app,
                Method::GET,
                "/admin/service-access",
                Some(&token(&state, uid)),
                Value::Null
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        request(&app, Method::GET, "/services", Some(&ordinary), Value::Null)
            .await
            .1["services"],
        json!([])
    );
    let mut data = catalog(&app, &admin).await;
    let stale = data.clone();
    let id = custom(&mut data, member);
    assert_eq!(save(&app, &ordinary, &data).await.0, StatusCode::FORBIDDEN);
    let (status, data) = save(&app, &admin, &data).await;
    assert_eq!(status, StatusCode::OK, "{data}");
    assert_eq!(save(&app, &admin, &stale).await.0, StatusCode::CONFLICT);
    let (status, visible) =
        request(&app, Method::GET, "/services", Some(&ordinary), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(visible["services"].as_array().unwrap().len(), 1);
    assert_eq!(visible["services"][0]["id"], "printer");
    assert!(!visible.to_string().contains("127.0.0.1"));
    assert!(!state.is_admin(member as i64).await);
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/admin/stats",
            Some(&ordinary),
            Value::Null
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(&app, Method::GET, "/services", Some(&admin), Value::Null)
            .await
            .1["services"],
        json!([]),
        "admin is not a service grant"
    );
    for mutate in [
        "delete-built-in",
        "rename-built-in",
        "builtin-members",
        "unknown-service",
        "guest",
        "duplicate",
    ] {
        let mut bad = data.clone();
        match mutate {
            "delete-built-in" => {
                bad["access"]["roles"].as_array_mut().unwrap().remove(0);
            }
            "rename-built-in" => bad["access"]["roles"][0]["name"] = json!("Other"),
            "builtin-members" => bad["access"]["roles"][0]["members"] = json!([member]),
            "unknown-service" => bad["access"]["roles"][6]["services"] = json!(["not-registered"]),
            "guest" => bad["access"]["roles"][6]["members"] = json!([guest]),
            _ => {
                let row = bad["access"]["roles"][6].clone();
                bad["access"]["roles"].as_array_mut().unwrap().push(row);
            }
        }
        assert_eq!(
            save(&app, &admin, &bad).await.0,
            StatusCode::BAD_REQUEST,
            "{mutate}"
        );
    }
    let mut renamed = data.clone();
    renamed["access"]["roles"][6]["name"] = json!("New team name");
    let (status, mut renamed) = save(&app, &admin, &renamed).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(renamed["access"]["roles"][6]["id"], id);
    renamed["access"]["roles"].as_array_mut().unwrap().pop();
    assert_eq!(save(&app, &admin, &renamed).await.0, StatusCode::OK);
    assert_eq!(
        request(&app, Method::GET, "/services", Some(&ordinary), Value::Null)
            .await
            .1["services"],
        json!([])
    );
}

async fn ws_connect(
    address: std::net::SocketAddr,
    id: &str,
    token: &str,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    tokio_tungstenite::tungstenite::Error,
> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut req = format!("ws://{address}/services/{id}/connect")
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    tokio_tungstenite::connect_async(req)
        .await
        .map(|(socket, _)| socket)
}
#[tokio::test]
async fn real_tcp_gateway_denies_ungranted_and_stops_after_revocation() {
    use futures::{SinkExt, StreamExt};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, member, _) = seed(&state).await;
    let app = router(&state);
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    register(dir.path(), upstream.local_addr().unwrap(), true);
    let admin = token(&state, owner);
    let ordinary = token(&state, member);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let http = tokio::spawn(axum::serve(listener, app.clone()).into_future());
    for (id, token) in [
        ("printer", &ordinary),
        ("printer", &admin),
        ("unknown", &ordinary),
    ] {
        let error = ws_connect(address, id, token).await.unwrap_err();
        assert!(
            matches!(error, tokio_tungstenite::tungstenite::Error::Http(ref r) if r.status() == StatusCode::FORBIDDEN)
        );
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(50), upstream.accept())
            .await
            .is_err(),
        "denials must never connect to target"
    );
    let mut data = catalog(&app, &admin).await;
    custom(&mut data, member);
    let (status, mut data) = save(&app, &admin, &data).await;
    assert_eq!(status, StatusCode::OK);
    assert!(ws_connect(address, "minecraft", &ordinary).await.is_err());
    let mut socket = ws_connect(address, "printer", &ordinary).await.unwrap();
    let (mut tcp, _) = tokio::time::timeout(Duration::from_secs(3), upstream.accept())
        .await
        .unwrap()
        .unwrap();
    socket
        .send(tokio_tungstenite::tungstenite::Message::Binary(
            b"real printer payload".to_vec().into(),
        ))
        .await
        .unwrap();
    let mut bytes = [0; 20];
    tokio::time::timeout(Duration::from_secs(3), tcp.read_exact(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&bytes, b"real printer payload");
    tcp.write_all(b"printed").await.unwrap();
    assert_eq!(
        socket.next().await.unwrap().unwrap().into_data(),
        b"printed".as_slice()
    );
    data["access"]["roles"][6]["services"] = json!([]);
    assert_eq!(save(&app, &admin, &data).await.0, StatusCode::OK);
    let ended = tokio::time::timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap();
    assert!(
        ended.is_none()
            || matches!(
                ended,
                Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))
            )
    );
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), tcp.read(&mut bytes))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    assert!(ws_connect(address, "printer", &ordinary).await.is_err());
    // Explicit exposure remains an independent gate, even with the role grant.
    let mut data = catalog(&app, &admin).await;
    data["access"]["roles"][6]["services"] = json!(["printer"]);
    assert_eq!(save(&app, &admin, &data).await.0, StatusCode::OK);
    register(dir.path(), upstream.local_addr().unwrap(), false);
    assert!(ws_connect(address, "printer", &ordinary).await.is_err());
    http.abort();
}

#[tokio::test]
async fn corrupt_storage_and_registry_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, member, _) = seed(&state).await;
    let app = router(&state);
    register(dir.path(), "127.0.0.1:9100".parse().unwrap(), true);
    let admin = token(&state, owner);
    let mut data = catalog(&app, &admin).await;
    custom(&mut data, member);
    assert_eq!(save(&app, &admin, &data).await.0, StatusCode::OK);
    let p = state.wdb.engine().projection_state();
    p.insert(
        "service_access",
        b"v1".to_vec(),
        b"corruption".to_vec(),
        p.applied_commit_seq(),
    );
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/services",
            Some(&token(&state, member)),
            Value::Null
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        save(&app, &admin, &data).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    std::fs::write(dir.path().join("service_endpoints.json"), "broken").unwrap();
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/admin/service-access",
            Some(&admin),
            Value::Null
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
#[ignore]
async fn write_service_fixture_child() {
    let path = std::env::var("WABI_SERVICE_REPLAY_DIR").unwrap();
    let state = server(Path::new(&path)).await;
    let (owner, member, _) = seed(&state).await;
    let app = router(&state);
    register(Path::new(&path), "127.0.0.1:9100".parse().unwrap(), true);
    let admin = token(&state, owner);
    let mut data = catalog(&app, &admin).await;
    custom(&mut data, member);
    assert_eq!(save(&app, &admin, &data).await.0, StatusCode::OK);
}
#[tokio::test]
async fn grants_replay_after_process_restart() {
    let dir = tempfile::tempdir().unwrap();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "write_service_fixture_child", "--ignored"])
        .env("WABI_SERVICE_REPLAY_DIR", dir.path())
        .output()
        .unwrap();
    assert!(
        child.status.success(),
        "{}",
        String::from_utf8_lossy(&child.stderr)
    );
    let state = server(dir.path()).await;
    let app = router(&state);
    let uid = state
        .wdb
        .list_users()
        .await
        .unwrap()
        .into_iter()
        .find(|u| u.username == "member")
        .unwrap()
        .user_id;
    let (status, data) = request(
        &app,
        Method::GET,
        "/services",
        Some(&token(&state, uid)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(data["services"][0]["id"], "printer");
    assert!(!state.is_admin(uid as i64).await);
}

#[tokio::test]
async fn builtin_grants_follow_current_role_and_concurrent_saves_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, member, _) = seed(&state).await;
    let app = router(&state);
    register(dir.path(), "127.0.0.1:9100".parse().unwrap(), true);
    let admin = token(&state, owner);
    let ordinary = token(&state, member);
    let mut data = catalog(&app, &admin).await;
    data["access"]["roles"][5]["services"] = json!(["future"]);
    let (a, b) = tokio::join!(save(&app, &admin, &data), save(&app, &admin, &data));
    assert!(
        (a.0 == StatusCode::OK && b.0 == StatusCode::CONFLICT)
            || (b.0 == StatusCode::OK && a.0 == StatusCode::CONFLICT)
    );
    let before = request(&app, Method::GET, "/services", Some(&ordinary), Value::Null)
        .await
        .1;
    assert_eq!(before["services"][0]["id"], "future");
    state.wdb.ingest_event("rbac", "assign_role", &json!({"userId":member,"workspaceId":"default-workspace","role":"Moderator","assignedBy":owner})).await.unwrap();
    assert_eq!(
        request(&app, Method::GET, "/services", Some(&ordinary), Value::Null)
            .await
            .1["services"],
        json!([]),
        "higher authority role does not inherit Member service grants"
    );
    assert_eq!(
        save(&app, &ordinary, &catalog(&app, &admin).await).await.0,
        StatusCode::FORBIDDEN
    );
    state.revoke_user(member as i64).await.unwrap();
    assert_eq!(
        request(&app, Method::GET, "/services", Some(&ordinary), Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn open_gateway_rechecks_account_revocation_and_exposure() {
    use futures::StreamExt;
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, member, _) = seed(&state).await;
    let app = router(&state);
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    register(dir.path(), upstream.local_addr().unwrap(), true);
    let admin = token(&state, owner);
    let ordinary = token(&state, member);
    let mut data = catalog(&app, &admin).await;
    custom(&mut data, member);
    assert_eq!(save(&app, &admin, &data).await.0, StatusCode::OK);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let http = tokio::spawn(axum::serve(listener, app).into_future());
    let mut socket = ws_connect(address, "printer", &ordinary).await.unwrap();
    let (tcp, _) = upstream.accept().await.unwrap();
    register(dir.path(), upstream.local_addr().unwrap(), false);
    let ended = tokio::time::timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap();
    assert!(
        ended.is_none()
            || matches!(
                ended,
                Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))
            )
    );
    drop(tcp);
    register(dir.path(), upstream.local_addr().unwrap(), true);
    let mut socket = ws_connect(address, "printer", &ordinary).await.unwrap();
    let (_tcp, _) = upstream.accept().await.unwrap();
    state.revoke_user(member as i64).await.unwrap();
    let ended = tokio::time::timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap();
    assert!(
        ended.is_none()
            || matches!(
                ended,
                Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))
            )
    );
    assert!(ws_connect(address, "printer", &ordinary).await.is_err());
    http.abort();
}
