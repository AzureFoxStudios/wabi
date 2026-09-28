//! Service grants never grant transport admission or server administrative rights.
use crate::{
    api::payments::json_error,
    auth_extractor::{authenticate_access_token, AuthUser},
    state::AppState,
};
use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, State, WebSocketUpgrade,
    },
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::get,
    Json, Router,
};
use futures::SinkExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::HashSet, net::SocketAddr, sync::Arc, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wabidb::{
    engine::wabi_store::WabiStore,
    format::record::RecordKind,
    projections::service_access::{self as model, ServiceAccess, ServiceRole, BUILTINS},
    sequencer::types::{CommandCommit, EventToWrite},
};
type ApiResult<T> = Result<T, Response>;
fn unavailable() -> Response {
    json_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "Service access storage or configuration unavailable",
    )
}
fn invalid(message: &str) -> Response {
    json_error(StatusCode::BAD_REQUEST, message)
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegisteredService {
    id: String,
    name: String,
    kind: String,
    // Literal operator-configured target, never returned to clients.
    address: SocketAddr,
    exposed: bool,
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
}
async fn registry(state: &AppState) -> ApiResult<Vec<RegisteredService>> {
    let path = std::path::Path::new(&state.config.data_dir).join("service_endpoints.json");
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err(unavailable()),
    };
    if bytes.len() > 65536 {
        return Err(unavailable());
    }
    let rows: Vec<RegisteredService> = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    let mut ids = HashSet::new();
    if rows.len() > 128
        || rows.iter().any(|r| {
            !valid_id(&r.id)
                || !ids.insert(&r.id)
                || r.name.trim().is_empty()
                || r.name.len() > 80
                || r.kind.len() > 40
                || r.address.port() == 0
                || r.address.ip().is_unspecified()
                || r.address.ip().is_multicast()
        })
    {
        return Err(unavailable());
    }
    Ok(rows)
}
fn load(state: &AppState) -> ApiResult<ServiceAccess> {
    state
        .wdb
        .engine()
        .projection_state()
        .get(model::INDEX, model::KEY)
        .map(|bytes| model::decode(&bytes).map_err(|_| unavailable()))
        .transpose()
        .map(|r| r.unwrap_or_default())
}
async fn account(state: &AppState, auth: &AuthUser) -> ApiResult<()> {
    if auth.is_guest || auth.is_bot || auth.user_id <= 0 {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Registered account required",
        ));
    }
    let user = state
        .wdb
        .get_user(auth.user_id as u64)
        .await
        .map_err(|_| unavailable())?;
    if !user.is_some_and(|u| u.is_active && !u.password_hash.is_empty()) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Active registered account required",
        ));
    }
    Ok(())
}
async fn effective_role(state: &AppState, uid: i64) -> ApiResult<&'static str> {
    let stored = state
        .wdb
        .get_user_role("default-workspace", uid as u64)
        .await
        .map_err(|_| unavailable())?;
    if state.is_owner(uid).await {
        return Ok("owner");
    }
    if state.config.admin_user_ids.contains(&uid) || stored.as_deref() == Some("Admin") {
        return Ok("admin");
    }
    Ok(match stored.as_deref() {
        Some("Developer") => "developer",
        Some("Moderator") => "mod",
        Some("Artist") => "artist",
        _ => "member",
    })
}
async fn allowed(state: &AppState, auth: &AuthUser, id: &str) -> ApiResult<RegisteredService> {
    account(state, auth).await?;
    let service = registry(state)
        .await?
        .into_iter()
        .find(|r| r.id == id && r.exposed)
        .ok_or_else(|| json_error(StatusCode::FORBIDDEN, "Service unavailable or not granted"))?;
    let builtin = format!("builtin:{}", effective_role(state, auth.user_id).await?);
    if !load(state)?.roles.iter().any(|r| {
        (r.id == builtin
            || (!r.id.starts_with("builtin:") && r.members.contains(&(auth.user_id as u64))))
            && r.services.iter().any(|s| s == id)
    }) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Service unavailable or not granted",
        ));
    }
    Ok(service)
}
async fn snapshot(state: &AppState) -> ApiResult<Json<serde_json::Value>> {
    let services = registry(state)
        .await?
        .iter()
        .map(|r| json!({"id":r.id,"name":r.name,"kind":r.kind,"exposed":r.exposed}))
        .collect::<Vec<_>>();
    let members = state
        .wdb
        .list_users()
        .await
        .map_err(|_| unavailable())?
        .into_iter()
        .filter(|u| u.is_active && !u.password_hash.is_empty())
        .map(|u| json!({"id":u.user_id,"name":u.username}))
        .collect::<Vec<_>>();
    Ok(Json(
        json!({"access":load(state)?,"services":services,"members":members}),
    ))
}
async fn administrator(headers: &HeaderMap, state: &Arc<AppState>) -> ApiResult<i64> {
    let auth = super::payments::authenticate_account(headers, state).await?;
    account(state, &auth).await?;
    super::admin::admin_auth(headers, state).await
}
async fn admin_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    let _gate = state.membership_gate.read().await;
    administrator(&headers, &state).await?;
    snapshot(&state).await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Save {
    revision: String,
    roles: Vec<ServiceRole>,
}
async fn admin_save(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<Save>,
) -> ApiResult<Json<serde_json::Value>> {
    let _gate = state.membership_gate.write().await;
    let actor = administrator(&headers, &state).await?;
    let previous = load(&state)?;
    if previous.revision != input.revision {
        return Err(json_error(
            StatusCode::CONFLICT,
            "Roles changed. Reload before trying again.",
        ));
    }
    let services = registry(&state).await?;
    let users = state.wdb.list_users().await.map_err(|_| unavailable())?;
    if input.roles.len() < BUILTINS.len() || input.roles.len() > 134 {
        return Err(invalid("Too many or missing roles"));
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for r in &input.roles {
        if !ids.insert(r.id.clone())
            || r.name.trim() != r.name
            || r.name.is_empty()
            || r.name.chars().count() > 40
            || r.name.chars().any(char::is_control)
            || !names.insert(r.name.to_lowercase())
            || r.services.len() > 128
            || r.members.len() > 10000
        {
            return Err(invalid("Invalid or duplicate role"));
        }
        if let Some(id) = r.id.strip_prefix("builtin:") {
            if !BUILTINS
                .iter()
                .any(|(key, name)| *key == id && *name == r.name)
                || !r.members.is_empty()
            {
                return Err(invalid(
                    "Built-in authority roles cannot be renamed or assigned here",
                ));
            }
        } else if uuid::Uuid::parse_str(&r.id).is_err() {
            return Err(invalid("Custom role ID must be a UUID"));
        }
        let mut seen = HashSet::new();
        for service in &r.services {
            let retained = previous
                .roles
                .iter()
                .any(|old| old.id == r.id && old.services.contains(service));
            if !seen.insert(service) || (!services.iter().any(|s| s.id == *service) && !retained) {
                return Err(invalid("Unknown or duplicate service"));
            }
        }
        let mut seen = HashSet::new();
        for uid in &r.members {
            let retained = previous
                .roles
                .iter()
                .any(|old| old.id == r.id && old.members.contains(uid));
            if !seen.insert(uid)
                || (!retained
                    && !users
                        .iter()
                        .any(|u| u.user_id == *uid && u.is_active && !u.password_hash.is_empty()))
            {
                return Err(invalid("Unknown, inactive or duplicate member"));
            }
        }
    }
    for (id, _) in BUILTINS {
        if !ids.contains(&format!("builtin:{id}")) {
            return Err(invalid("Built-in authority roles cannot be deleted"));
        }
    }
    let row = ServiceAccess {
        schema: 1,
        revision: uuid::Uuid::new_v4().to_string(),
        roles: input.roles,
        updated_by: actor as u64,
    };
    let plaintext = serde_json::to_vec(&row).map_err(|_| unavailable())?;
    model::decode(&plaintext).map_err(|_| invalid("Role catalog exceeds storage limits"))?;
    let engine = state.wdb.engine();
    engine
        .get_or_create_stream_key("service-access:v1")
        .await
        .map_err(|_| unavailable())?;
    engine
        .run_command(CommandCommit {
            room_owner_precondition: None,
            caller_user_id: actor as u64,
            caller_device_id: "primary".into(),
            command_name: model::EVENT.into(),
            idempotency_key: None,
            essential: true,
            response_tx: tokio::sync::oneshot::channel().0,
            events: vec![EventToWrite {
                stream_id: "service-access:v1".into(),
                stream_kind: 6,
                event_type: model::EVENT.into(),
                record_kind: RecordKind::Event,
                plaintext,
            }],
        })
        .await
        .map_err(|_| unavailable())?;
    snapshot(&state).await
}
async fn list(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
) -> ApiResult<Json<serde_json::Value>> {
    let _gate = state.membership_gate.read().await;
    account(&state, &auth).await?;
    let mut services = vec![];
    for service in registry(&state).await? {
        match allowed(&state, &auth, &service.id).await {
            Ok(_) => {
                services.push(json!({"id":service.id,"name":service.name,"kind":service.kind}))
            }
            Err(e) if e.status() == StatusCode::FORBIDDEN => {}
            Err(e) => return Err(e),
        }
    }
    Ok(Json(json!({"services":services})))
}
// Generic TCP-over-WebSocket; callers cannot choose a destination or subnet.
static CONNECTIONS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(128);
async fn connect(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    auth: AuthUser,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    let _gate = state.membership_gate.read().await;
    let service = allowed(&state, &auth, &id).await?;
    let token = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or_else(|| invalid("Account Bearer token required"))?
        .to_owned();
    let permit = CONNECTIONS.try_acquire().map_err(|_| {
        json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Service connection limit reached",
        )
    })?;
    drop(_gate);
    Ok(ws
        .max_message_size(65536)
        .max_frame_size(65536)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            bridge(socket, state, id, token, service.address).await;
        }))
}
async fn bridge(
    mut socket: WebSocket,
    state: Arc<AppState>,
    id: String,
    token: String,
    address: SocketAddr,
) {
    let _gate = state.membership_gate.read().await;
    let Ok(auth) = authenticate_access_token(&state, &token).await else {
        return;
    };
    if !allowed(&state, &auth, &id)
        .await
        .is_ok_and(|s| s.address == address)
    {
        return;
    }
    let Ok(Ok(mut tcp)) = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::TcpStream::connect(address),
    )
    .await
    else {
        return;
    };
    drop(_gate);
    let mut buffer = vec![0; 32768];
    let mut check = tokio::time::interval(Duration::from_secs(1));
    let mut last_payload = std::time::Instant::now();
    loop {
        enum Event {
            Socket(Option<Result<Message, axum::Error>>),
            Tcp(std::io::Result<usize>),
            Tick,
        }
        let event = tokio::select! {
            message = socket.recv() => Event::Socket(message),
            bytes = tcp.read(&mut buffer) => Event::Tcp(bytes),
            _ = check.tick() => Event::Tick,
        };
        if last_payload.elapsed() > Duration::from_secs(300) {
            break;
        }
        // Same gate as mutations: a committed deletion cannot pass more bytes.
        let _gate = state.membership_gate.read().await;
        let Ok(auth) = authenticate_access_token(&state, &token).await else {
            break;
        };
        if !allowed(&state, &auth, &id)
            .await
            .is_ok_and(|s| s.address == address)
        {
            break;
        }
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            match event {
                Event::Tcp(Ok(n)) if n > 0 => {
                    last_payload = std::time::Instant::now();
                    socket
                        .send(Message::Binary(buffer[..n].to_vec().into()))
                        .await
                        .is_ok()
                }
                Event::Socket(Some(Ok(Message::Binary(data)))) => {
                    last_payload = std::time::Instant::now();
                    tcp.write_all(&data).await.is_ok()
                }
                Event::Socket(Some(Ok(Message::Ping(data)))) => {
                    socket.send(Message::Pong(data)).await.is_ok()
                }
                Event::Socket(Some(Ok(Message::Pong(_)))) | Event::Tick => true,
                _ => false,
            }
        })
        .await;
        if result != Ok(true) {
            break;
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), socket.close()).await;
}
pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/admin/service-access", get(admin_get).put(admin_save))
        .route("/services", get(list))
        .route("/services/{id}/connect", get(connect))
        .with_state(state)
}
