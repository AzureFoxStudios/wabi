//! Regional Anchor proxy without canonical community state.
//!
//! Anchor mode is intentionally not a replica. It forwards requests to the
//! authority, preserves method/path/query/body/auth headers, and fails fast when
//! the authority is unreachable. It does not require or initialize WDB. An
//! optional bounded RAM cache can retain verified upload bytes temporarily.

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{
        ws::{rejection::WebSocketUpgradeRejection, Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, OriginalUri, State,
    },
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use futures::{SinkExt, StreamExt};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, Semaphore};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message as UpstreamMessage},
};

use crate::rate_limit::TrustedProxyConfig;

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct AnchorState {
    authority_url: String,
    client: reqwest::Client,
    upload_cache: Option<Arc<Mutex<UploadCache>>>,
    fill_gates: Arc<Vec<Mutex<()>>>,
    fill_permits: Arc<Semaphore>,
    trusted_proxies: TrustedProxyConfig,
}

const MAX_UPLOAD_CACHE_MB: usize = 1024;
const MAX_CACHED_UPLOAD_BYTES: usize = 8 * 1024 * 1024;
const CACHE_FILL_SHARDS: usize = 64;

#[derive(Clone, Debug)]
struct CachedUpload {
    etag: String,
    bytes: Bytes,
}

#[derive(Debug)]
struct UploadCache {
    limit: usize,
    used: usize,
    entries: HashMap<String, CachedUpload>,
    order: VecDeque<String>,
}

impl UploadCache {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            used: 0,
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn remove(&mut self, key: &str) {
        if let Some(entry) = self.entries.remove(key) {
            self.used -= entry.bytes.len();
            self.order.retain(|name| name != key);
        }
    }

    fn get(&mut self, key: &str, etag: &str) -> Option<CachedUpload> {
        let entry = self.entries.get(key)?.clone();
        if entry.etag != etag {
            self.remove(key);
            return None;
        }
        self.order.retain(|name| name != key);
        self.order.push_back(key.to_string());
        Some(entry)
    }

    fn insert(&mut self, key: String, entry: CachedUpload) {
        self.remove(&key);
        let size = entry.bytes.len();
        if size > self.limit || size > MAX_CACHED_UPLOAD_BYTES {
            return;
        }
        while self.used + size > self.limit {
            if let Some(oldest) = self.order.pop_front() {
                if let Some(old) = self.entries.remove(&oldest) {
                    self.used -= old.bytes.len();
                }
            } else {
                break;
            }
        }
        self.used += size;
        self.order.push_back(key.clone());
        self.entries.insert(key, entry);
    }
}

#[allow(dead_code)]
impl AnchorState {
    pub fn new(authority_url: String) -> anyhow::Result<Self> {
        let cache_mb = std::env::var("WABI_ANCHOR_UPLOAD_CACHE_MB")
            .ok()
            .map(|value| value.parse::<usize>())
            .transpose()?
            .unwrap_or(0);
        anyhow::ensure!(
            cache_mb <= MAX_UPLOAD_CACHE_MB,
            "WABI_ANCHOR_UPLOAD_CACHE_MB must be between 0 and {MAX_UPLOAD_CACHE_MB}"
        );
        Self::new_with_cache_bytes(authority_url, cache_mb * 1024 * 1024)
    }

    fn new_with_cache_bytes(authority_url: String, cache_bytes: usize) -> anyhow::Result<Self> {
        let allow_private_http = std::env::var("WABI_ANCHOR_ALLOW_PRIVATE_HTTP")
            .ok()
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("true"));
        validate_authority_url(&authority_url, allow_private_http)?;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            // A total-request timeout cuts off large uploads and long-lived
            // polling responses. Bound idle reads while preserving streaming.
            .read_timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            authority_url: authority_url.trim_end_matches('/').to_string(),
            client,
            upload_cache: (cache_bytes > 0)
                .then(|| Arc::new(Mutex::new(UploadCache::new(cache_bytes)))),
            fill_gates: Arc::new((0..CACHE_FILL_SHARDS).map(|_| Mutex::new(())).collect()),
            fill_permits: Arc::new(Semaphore::new(8)),
            trusted_proxies: TrustedProxyConfig::from_env(),
        })
    }

    fn forwarded_for(&self, headers: &HeaderMap, peer: SocketAddr) -> String {
        let client = self.trusted_proxies.client_ip(headers, peer);
        if client == peer.ip() {
            peer.ip().to_string()
        } else {
            // Preserve only the authenticated proxy interpretation, then
            // append the real peer. Never relay the client's arbitrary chain.
            format!("{client}, {}", peer.ip())
        }
    }
}

/// Protect forwarded sessions from an accidental public plaintext uplink.
/// Private HTTP is an explicit operator decision for a protected network.
fn validate_authority_url(authority_url: &str, allow_private_http: bool) -> anyhow::Result<()> {
    let url = reqwest::Url::parse(authority_url)?;
    anyhow::ensure!(
        url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/",
        "WABI_AUTHORITY_URL must be an origin without credentials, path, query or fragment"
    );
    let host = url.host_str().unwrap_or("").trim_matches(&['[', ']'][..]);
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback());
    let private_ip = host.parse::<IpAddr>().is_ok_and(|address| match address {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            ip.is_private() || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        IpAddr::V6(ip) => ip.is_unique_local(),
    });
    anyhow::ensure!(
        url.scheme() == "https"
            || (url.scheme() == "http" && (loopback || allow_private_http && private_ip)),
        "Anchor upstream must use HTTPS; protected private-IP HTTP requires WABI_ANCHOR_ALLOW_PRIVATE_HTTP=true"
    );
    Ok(())
}

#[allow(dead_code)]
pub fn create_anchor_router(authority_url: String) -> anyhow::Result<Router> {
    let state = Arc::new(AnchorState::new(authority_url)?);
    Ok(create_router(state))
}

fn create_router(state: Arc<AnchorState>) -> Router {
    Router::new()
        .route("/health", get(anchor_health))
        .fallback(proxy_to_authority)
        .with_state(state)
}

#[allow(dead_code)]
async fn anchor_health() -> impl IntoResponse {
    (
        [(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")],
        Json(json!({
            "status": "ok",
            "service": "wabi-server",
            "role": "anchor",
            "version": env!("CARGO_PKG_VERSION"),
            "timestamp": chrono::Utc::now().to_rfc3339()
        })),
    )
}

#[allow(dead_code)]
async fn proxy_to_authority(
    State(state): State<Arc<AnchorState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
    body: Body,
) -> Response {
    if headers
        .get(header::UPGRADE)
        .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"))
    {
        return match ws {
            Ok(ws) => websocket_to_authority(&state, &uri, &headers, peer, ws).await,
            Err(rejection) => rejection.into_response(),
        };
    }

    if let Some(response) = crate::app_router::embedded_immutable_asset(&method, &uri) {
        return response;
    }

    if method == Method::GET && state.upload_cache.is_some() {
        if let Some(key) = cacheable_upload_key(&uri, &headers) {
            return match cached_upload(&state, &key, uri, headers, peer).await {
                Ok(response) => response,
                Err(error) => authority_unavailable(error),
            };
        }
    }

    match forward(&state, method, uri, headers, peer, body).await {
        Ok(response) => response,
        Err(error) => authority_unavailable(error),
    }
}

fn authority_unavailable(error: anyhow::Error) -> Response {
    // Transport errors can include the private upstream origin and request
    // URL. Keep their diagnostics in operator logs instead of public JSON.
    tracing::warn!(%error, "Anchor Authority request failed");
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"error": "authority unavailable", "role": "anchor"})),
    )
        .into_response()
}

#[allow(dead_code)]
async fn forward(
    state: &AnchorState,
    method: Method,
    uri: axum::http::Uri,
    headers: HeaderMap,
    peer: SocketAddr,
    body: Body,
) -> anyhow::Result<Response> {
    let target = target_url(&state.authority_url, &uri);
    let reqwest_method = reqwest::Method::from_bytes(method.as_str().as_bytes())?;
    let mut request = state
        .client
        .request(reqwest_method, target)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()));

    for (name, value) in headers.iter() {
        if is_hop_by_hop_header(name.as_str())
            || name.as_str().eq_ignore_ascii_case("host")
            || is_forwarding_header(name.as_str())
        {
            continue;
        }
        request = request.header(name, value);
    }
    request = request.header("x-forwarded-for", state.forwarded_for(&headers, peer));

    let upstream = request.send().await?;
    let status = StatusCode::from_u16(upstream.status().as_u16())?;
    let mut builder = Response::builder().status(status);
    for (name, value) in upstream.headers().iter() {
        if is_hop_by_hop_header(name.as_str()) {
            continue;
        }
        builder = builder.header(name, value);
    }
    Ok(builder.body(Body::from_stream(upstream.bytes_stream()))?)
}

fn cacheable_upload_key(uri: &axum::http::Uri, headers: &HeaderMap) -> Option<String> {
    if uri.query().is_some()
        || [
            header::RANGE,
            header::IF_RANGE,
            header::IF_NONE_MATCH,
            header::IF_MODIFIED_SINCE,
        ]
        .iter()
        .any(|name| headers.contains_key(name))
        || request_forbids_upload_cache(headers)
    {
        return None;
    }
    let filename = uri.path().strip_prefix("/uploads/")?;
    if filename.is_empty()
        || filename.len() > 255
        || filename.contains("..")
        || !filename
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return None;
    }
    Some(filename.to_string())
}

fn request_forbids_upload_cache(headers: &HeaderMap) -> bool {
    for value in headers.get_all(header::CACHE_CONTROL).iter() {
        let Ok(policy) = value.to_str() else {
            return true;
        };
        if policy
            .split(',')
            .map(str::trim)
            .any(|directive| directive.eq_ignore_ascii_case("no-store"))
        {
            return true;
        }
    }
    false
}

fn cache_etag(headers: &HeaderMap) -> Option<String> {
    let etag = headers.get(header::ETAG)?.to_str().ok()?;
    let digest = etag.strip_prefix("\"sha256-")?.strip_suffix('"')?;
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(etag.to_string())
}

fn allows_revalidated_upload_cache(headers: &HeaderMap) -> bool {
    let mut revalidate = false;
    for value in headers.get_all(header::CACHE_CONTROL).iter() {
        let Ok(policy) = value.to_str() else {
            return false;
        };
        for directive in policy.split(',').map(str::trim) {
            if directive.eq_ignore_ascii_case("no-store") {
                return false;
            }
            if directive.eq_ignore_ascii_case("no-cache") {
                revalidate = true;
            }
        }
    }
    revalidate
}

fn cached_response(
    entry: CachedUpload,
    fresh_headers: &HeaderMap,
    disposition: &'static str,
) -> Response {
    let mut response = Response::builder().status(StatusCode::OK);
    for (name, value) in fresh_headers {
        response = response.header(name, value);
    }
    response
        .header("x-wabi-anchor-cache", disposition)
        .body(Body::from(entry.bytes))
        .expect("cached response headers were received from the Authority")
}

async fn cached_upload(
    state: &AnchorState,
    filename: &str,
    uri: axum::http::Uri,
    headers: HeaderMap,
    peer: SocketAddr,
) -> anyhow::Result<Response> {
    let cache = state.upload_cache.as_ref().expect("cache route is enabled");
    let mut identity_headers = headers.clone();
    identity_headers.insert(header::ACCEPT_ENCODING, "identity".parse()?);
    // The Authority checks revocation and current availability on every
    // probe. This route uses capability URLs, not per-member file ACLs.
    // A disconnected Authority cannot authorize a cached response.
    let probe = forward(
        state,
        Method::HEAD,
        uri.clone(),
        identity_headers.clone(),
        peer,
        Body::empty(),
    )
    .await?;
    if probe.status() != StatusCode::OK {
        cache.lock().await.remove(filename);
        return forward(state, Method::GET, uri, headers, peer, Body::empty()).await;
    }
    if !allows_revalidated_upload_cache(probe.headers()) {
        cache.lock().await.remove(filename);
        return forward(state, Method::GET, uri, headers, peer, Body::empty()).await;
    }
    let etag = cache_etag(probe.headers());
    let length = probe
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    let limit = cache.lock().await.limit.min(MAX_CACHED_UPLOAD_BYTES);
    let (etag, length) = match (etag, length) {
        (Some(etag), Some(length)) if length <= limit => (etag, length),
        _ => {
            cache.lock().await.remove(filename);
            return forward(state, Method::GET, uri, headers, peer, Body::empty()).await;
        }
    };
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    filename.hash(&mut hasher);
    let shard = (hasher.finish() as usize) % CACHE_FILL_SHARDS;
    let _fill = state.fill_gates[shard].lock().await;
    if let Some(entry) = cache.lock().await.get(filename, &etag) {
        return Ok(cached_response(entry, probe.headers(), "hit"));
    }
    let _permit = state.fill_permits.acquire().await?;
    let response = forward(
        state,
        Method::GET,
        uri,
        identity_headers,
        peer,
        Body::empty(),
    )
    .await?;
    if response.status() != StatusCode::OK
        || cache_etag(response.headers()).as_deref() != Some(etag.as_str())
        || response
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok())
            != Some(length)
        || !allows_revalidated_upload_cache(response.headers())
    {
        return Ok(response);
    }
    let (parts, body) = response.into_parts();
    let bytes = match to_bytes(body, length).await {
        Ok(bytes) if bytes.len() == length => bytes,
        _ => {
            return Ok((StatusCode::BAD_GATEWAY, "Authority upload length changed").into_response())
        }
    };
    let expected = etag.trim_start_matches("\"sha256-").trim_end_matches('"');
    if hex::encode(Sha256::digest(&bytes)) != expected {
        return Ok((StatusCode::BAD_GATEWAY, "Authority upload digest changed").into_response());
    }
    let entry = CachedUpload {
        etag,
        bytes: bytes.clone(),
    };
    cache.lock().await.insert(filename.to_string(), entry);
    let mut response = Response::from_parts(parts, Body::from(bytes));
    response
        .headers_mut()
        .insert("x-wabi-anchor-cache", "miss".parse()?);
    Ok(response)
}

async fn websocket_to_authority(
    state: &AnchorState,
    uri: &axum::http::Uri,
    headers: &HeaderMap,
    peer: SocketAddr,
    mut ws: WebSocketUpgrade,
) -> Response {
    let result = async {
        let target = target_url(&state.authority_url, uri);
        let target = if let Some(rest) = target.strip_prefix("http://") {
            format!("ws://{rest}")
        } else if let Some(rest) = target.strip_prefix("https://") {
            format!("wss://{rest}")
        } else {
            anyhow::bail!("Authority URL must use HTTP or HTTPS");
        };
        let mut request = target.into_client_request()?;
        for name in [
            header::AUTHORIZATION,
            header::COOKIE,
            header::ORIGIN,
            header::SEC_WEBSOCKET_PROTOCOL,
        ] {
            if let Some(value) = headers.get(&name) {
                request.headers_mut().insert(name, value.clone());
            }
        }

        request.headers_mut().insert(
            "x-forwarded-for",
            state.forwarded_for(headers, peer).parse()?,
        );

        let (upstream, response) =
            tokio::time::timeout(Duration::from_secs(10), connect_async(request)).await??;
        if let Some(protocol) = response.headers().get(header::SEC_WEBSOCKET_PROTOCOL) {
            if !ws
                .requested_protocols()
                .any(|requested| requested == protocol)
            {
                anyhow::bail!("Authority selected an unrequested WebSocket protocol");
            }
            ws.set_selected_protocol(protocol.clone());
        }
        Ok::<_, anyhow::Error>(upstream)
    }
    .await;

    match result {
        Ok(upstream) => ws
            .on_upgrade(move |downstream| bridge_websocket(downstream, upstream))
            .into_response(),
        Err(error) => {
            tracing::warn!(%error, "Anchor Authority WebSocket request failed");
            let rejected_status = error
                .downcast_ref::<tokio_tungstenite::tungstenite::Error>()
                .and_then(|error| match error {
                    tokio_tungstenite::tungstenite::Error::Http(response) => {
                        StatusCode::from_u16(response.status().as_u16()).ok()
                    }
                    _ => None,
                });
            let status = rejected_status.unwrap_or(StatusCode::SERVICE_UNAVAILABLE);
            (
                status,
                Json(json!({
                    "error": if rejected_status.is_some() {
                        "authority rejected WebSocket"
                    } else {
                        "authority unavailable"
                    },
                    "role": "anchor"
                })),
            )
                .into_response()
        }
    }
}

async fn bridge_websocket(
    mut downstream: WebSocket,
    mut upstream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) {
    loop {
        tokio::select! {
            message = downstream.recv() => match message {
                Some(Ok(Message::Text(text))) => {
                    if upstream.send(UpstreamMessage::Text(text.to_string().into())).await.is_err() { break; }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    if upstream.send(UpstreamMessage::Binary(bytes)).await.is_err() { break; }
                }
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Close(frame))) => {
                    let frame = frame.map(|frame| tokio_tungstenite::tungstenite::protocol::CloseFrame {
                        code: frame.code.into(),
                        reason: frame.reason.to_string().into(),
                    });
                    let _ = upstream.send(UpstreamMessage::Close(frame)).await;
                    return;
                }
                Some(Err(_)) | None => break,
            },
            message = upstream.next() => match message {
                Some(Ok(UpstreamMessage::Text(text))) => {
                    if downstream.send(Message::Text(text.to_string().into())).await.is_err() { break; }
                }
                Some(Ok(UpstreamMessage::Binary(bytes))) => {
                    if downstream.send(Message::Binary(bytes)).await.is_err() { break; }
                }
                Some(Ok(UpstreamMessage::Ping(_))) | Some(Ok(UpstreamMessage::Pong(_))) => {}
                Some(Ok(UpstreamMessage::Frame(_))) => {}
                Some(Ok(UpstreamMessage::Close(frame))) => {
                    let frame = frame.map(|frame| axum::extract::ws::CloseFrame {
                        code: frame.code.into(),
                        reason: frame.reason.to_string().into(),
                    });
                    let _ = downstream.send(Message::Close(frame)).await;
                    return;
                }
                Some(Err(_)) | None => break,
            },
        }
    }
    let _ = downstream.close().await;
    let _ = upstream.close(None).await;
}

#[allow(dead_code)]
fn target_url(authority_url: &str, uri: &axum::http::Uri) -> String {
    let path_and_query = uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
    format!("{}{}", authority_url.trim_end_matches('/'), path_and_query)
}

fn is_forwarding_header(name: &str) -> bool {
    name.eq_ignore_ascii_case("forwarded")
        || name.eq_ignore_ascii_case("x-real-ip")
        || name.to_ascii_lowercase().starts_with("x-forwarded-")
}

#[allow(dead_code)]
fn is_hop_by_hop_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Bytes,
        extract::OriginalUri,
        routing::{any, post},
        Json, Router,
    };
    use serde_json::Value;
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tower::ServiceExt;

    async fn spawn_router(app: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{}", addr), handle)
    }

    async fn spawn_authority() -> (String, tokio::task::JoinHandle<()>) {
        async fn echo(
            method: Method,
            OriginalUri(uri): OriginalUri,
            headers: HeaderMap,
            body: Bytes,
        ) -> Json<Value> {
            Json(json!({
                "method": method.as_str(),
                "pathAndQuery": uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/"),
                "authorization": headers.get("authorization").and_then(|v| v.to_str().ok()),
                "forwardedFor": headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()),
                "forwarded": headers.get("forwarded").and_then(|v| v.to_str().ok()),
                "body": String::from_utf8_lossy(&body),
            }))
        }

        let app = Router::new().fallback(any(echo));
        spawn_router(app).await
    }

    async fn spawn_anchor(authority_url: String) -> (String, tokio::task::JoinHandle<()>) {
        let app = create_anchor_router(authority_url).unwrap();
        spawn_anchor_router(app).await
    }

    async fn spawn_anchor_router(app: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        (format!("http://{}", addr), handle)
    }

    #[derive(Default)]
    struct AssetProbe {
        gets: AtomicUsize,
        heads: AtomicUsize,
        revoked: AtomicBool,
        no_store: AtomicBool,
    }

    async fn cacheable_asset(
        State(probe): State<Arc<AssetProbe>>,
        method: Method,
        headers: HeaderMap,
    ) -> Response {
        if method == Method::HEAD {
            probe.heads.fetch_add(1, Ordering::Relaxed);
        } else {
            probe.gets.fetch_add(1, Ordering::Relaxed);
        }
        if probe.revoked.load(Ordering::Relaxed) {
            return StatusCode::GONE.into_response();
        }
        if headers
            .get(header::AUTHORIZATION)
            .map(|value| value.as_bytes())
            != Some(b"Bearer allowed".as_slice())
        {
            return StatusCode::FORBIDDEN.into_response();
        }
        let bytes = b"regional upload bytes";
        let etag = format!("\"sha256-{}\"", hex::encode(Sha256::digest(bytes)));
        Response::builder()
            .status(StatusCode::OK)
            .header(header::ETAG, etag)
            .header(header::CONTENT_LENGTH, bytes.len().to_string())
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(
                header::CACHE_CONTROL,
                if probe.no_store.load(Ordering::Relaxed) {
                    "private, no-store"
                } else {
                    "private, no-cache"
                },
            )
            .body(if method == Method::HEAD {
                Body::empty()
            } else {
                Body::from(bytes.as_slice())
            })
            .unwrap()
    }

    #[tokio::test]
    async fn regional_upload_cache_saves_origin_bytes_and_revalidates_denials() {
        let probe = Arc::new(AssetProbe::default());
        let (authority_url, authority_handle) = spawn_router(
            Router::new()
                .route("/uploads/art.bin", axum::routing::any(cacheable_asset))
                .with_state(probe.clone()),
        )
        .await;
        let (materials_url, materials_handle) = spawn_anchor_router(create_router(Arc::new(
            AnchorState::new_with_cache_bytes(authority_url.clone(), 1024 * 1024).unwrap(),
        )))
        .await;
        let (equipment_url, equipment_handle) = spawn_anchor_router(create_router(Arc::new(
            AnchorState::new_with_cache_bytes(authority_url, 1024 * 1024).unwrap(),
        )))
        .await;
        let client = reqwest::Client::new();
        for url in [&materials_url, &equipment_url] {
            for disposition in ["miss", "hit"] {
                let response = client
                    .get(format!("{url}/uploads/art.bin"))
                    .bearer_auth("allowed")
                    .send()
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::OK);
                assert_eq!(
                    response.headers().get("x-wabi-anchor-cache").unwrap(),
                    disposition
                );
                assert_eq!(
                    response.bytes().await.unwrap(),
                    b"regional upload bytes".as_slice()
                );
            }
        }
        assert_eq!(probe.gets.load(Ordering::Relaxed), 2);
        assert_eq!(probe.heads.load(Ordering::Relaxed), 4);
        probe.no_store.store(true, Ordering::Relaxed);
        for _ in 0..2 {
            let response = client
                .get(format!("{materials_url}/uploads/art.bin"))
                .bearer_auth("allowed")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert!(response.headers().get("x-wabi-anchor-cache").is_none());
        }
        assert_eq!(probe.gets.load(Ordering::Relaxed), 4);
        assert_eq!(probe.heads.load(Ordering::Relaxed), 6);
        probe.no_store.store(false, Ordering::Relaxed);
        assert_eq!(
            client
                .get(format!("{materials_url}/uploads/art.bin"))
                .bearer_auth("allowed")
                .send()
                .await
                .unwrap()
                .headers()
                .get("x-wabi-anchor-cache")
                .unwrap(),
            "miss"
        );
        assert_eq!(
            client
                .get(format!("{materials_url}/uploads/art.bin"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );

        probe.revoked.store(true, Ordering::Relaxed);
        for url in [&materials_url, &equipment_url] {
            assert_eq!(
                client
                    .get(format!("{url}/uploads/art.bin"))
                    .bearer_auth("allowed")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::GONE
            );
        }
        probe.revoked.store(false, Ordering::Relaxed);
        for url in [&materials_url, &equipment_url] {
            assert_eq!(
                client
                    .get(format!("{url}/uploads/art.bin"))
                    .bearer_auth("allowed")
                    .send()
                    .await
                    .unwrap()
                    .headers()
                    .get("x-wabi-anchor-cache")
                    .unwrap(),
                "miss"
            );
        }
        authority_handle.abort();
        for url in [&materials_url, &equipment_url] {
            assert_eq!(
                client
                    .get(format!("{url}/uploads/art.bin"))
                    .bearer_auth("allowed")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::SERVICE_UNAVAILABLE
            );
        }
        materials_handle.abort();
        equipment_handle.abort();
    }

    #[test]
    fn anchor_requires_secure_or_explicit_private_upstream() {
        assert!(validate_authority_url("http://127.0.0.1:3001", false).is_ok());
        assert!(validate_authority_url("https://203.0.113.7:3001", false).is_ok());
        assert!(validate_authority_url("http://203.0.113.7:3001", true).is_err());
        assert!(validate_authority_url("http://100.64.1.2:3001", false).is_err());
        assert!(validate_authority_url("http://100.64.1.2:3001", true).is_ok());
        assert!(validate_authority_url("http://192.168.1.2:3001", true).is_ok());
        assert!(validate_authority_url("https://operator:secret@example.com", false).is_err());
        assert!(validate_authority_url("https://example.com/path", false).is_err());
        assert!(validate_authority_url("https://example.com?next=elsewhere", false).is_err());
    }

    #[test]
    fn upload_cache_evicts_oldest_bytes_within_its_limit() {
        let mut cache = UploadCache::new(4);
        for (name, bytes) in [("a", b"aaa".as_slice()), ("b", b"bb".as_slice())] {
            cache.insert(
                name.into(),
                CachedUpload {
                    etag: name.into(),
                    bytes: Bytes::copy_from_slice(bytes),
                },
            );
        }
        assert_eq!(cache.used, 2);
        assert!(cache.get("a", "a").is_none());
        assert!(cache.get("b", "b").is_some());
        assert_eq!(cache.order.len(), 1);
    }

    #[test]
    fn upload_cache_requires_current_unqualified_revalidation_policy() {
        let mut headers = HeaderMap::new();
        assert!(!allows_revalidated_upload_cache(&headers));
        headers.insert(
            header::CACHE_CONTROL,
            "private, no-cache=Set-Cookie".parse().unwrap(),
        );
        assert!(!allows_revalidated_upload_cache(&headers));
        headers.insert(header::CACHE_CONTROL, "private, No-CaChE".parse().unwrap());
        assert!(allows_revalidated_upload_cache(&headers));
        headers.append(header::CACHE_CONTROL, "NO-STORE".parse().unwrap());
        assert!(!allows_revalidated_upload_cache(&headers));
    }

    #[test]
    fn client_no_store_bypasses_upload_cache_with_mixed_case_headers() {
        let uri = "/uploads/art.bin".parse().unwrap();
        let mut headers = HeaderMap::new();
        assert_eq!(
            cacheable_upload_key(&uri, &headers).as_deref(),
            Some("art.bin")
        );
        headers.insert(header::CACHE_CONTROL, "max-age=0".parse().unwrap());
        headers.append(header::CACHE_CONTROL, "NO-STORE".parse().unwrap());
        assert!(cacheable_upload_key(&uri, &headers).is_none());
    }

    #[tokio::test]
    async fn two_anchors_share_one_authority_and_fail_independently() {
        let (authority_url, authority_handle) = spawn_authority().await;
        let (materials_url, materials_handle) = spawn_anchor(authority_url.clone()).await;
        let (equipment_url, equipment_handle) = spawn_anchor(authority_url).await;
        let client = reqwest::Client::new();

        for anchor_url in [&materials_url, &equipment_url] {
            let response: Value = client
                .post(format!("{anchor_url}/api/jobs?site=roofing"))
                .bearer_auth("same-community-session")
                .body("material request")
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(response["authorization"], "Bearer same-community-session");
            assert_eq!(response["pathAndQuery"], "/api/jobs?site=roofing");
            assert_eq!(response["body"], "material request");
        }

        materials_handle.abort();
        let _ = materials_handle.await;
        assert_eq!(
            client
                .get(format!("{equipment_url}/api/jobs"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );

        authority_handle.abort();
        let _ = authority_handle.await;
        assert_eq!(
            client
                .get(format!("{equipment_url}/api/jobs"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        equipment_handle.abort();
    }

    #[tokio::test]
    async fn public_anchor_health_does_not_disclose_private_upstream() {
        let app = create_anchor_router("http://127.0.0.1:34567".into()).unwrap();
        let response = app
            .oneshot(
                axum::http::Request::get("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            "*"
        );
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let health: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(health["role"], "anchor");
        assert!(health.get("authorityUrl").is_none());
        assert!(!String::from_utf8_lossy(&body).contains("127.0.0.1:34567"));
    }

    #[tokio::test]
    async fn anchor_serves_embedded_immutable_assets_locally_and_forwards_missing_versions() {
        let path = crate::app_router::embedded_immutable_sample_path()
            .expect("frontend build must contain an immutable JS asset");
        let upstream_calls = Arc::new(AtomicUsize::new(0));
        let calls = upstream_calls.clone();
        let authority = Router::new().fallback(move || {
            let calls = calls.clone();
            async move {
                calls.fetch_add(1, Ordering::Relaxed);
                (StatusCode::OK, "upstream response")
            }
        });
        let (authority_url, authority_handle) = spawn_router(authority).await;
        let (anchor_url, anchor_handle) = spawn_anchor(authority_url).await;
        let client = reqwest::Client::new();

        let local = client
            .get(format!("{anchor_url}{path}"))
            .send()
            .await
            .unwrap();
        assert_eq!(local.status(), StatusCode::OK);
        assert_eq!(local.headers()["x-wabi-anchor-static"], "local");
        assert_eq!(
            local.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(local.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        let length = local.headers()[header::CONTENT_LENGTH]
            .to_str()
            .unwrap()
            .parse::<usize>()
            .unwrap();
        assert_eq!(local.bytes().await.unwrap().len(), length);
        assert!(length > 0);
        assert_eq!(upstream_calls.load(Ordering::Relaxed), 0);

        let head = client
            .head(format!("{anchor_url}{path}"))
            .send()
            .await
            .unwrap();
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.headers()["x-wabi-anchor-static"], "local");
        assert_eq!(head.headers()[header::CONTENT_LENGTH], length.to_string());
        assert!(head.bytes().await.unwrap().is_empty());
        assert_eq!(upstream_calls.load(Ordering::Relaxed), 0);

        for path in ["/_app/immutable/chunks/absent-version.js", "/"] {
            let response = client
                .get(format!("{anchor_url}{path}"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.text().await.unwrap(), "upstream response");
        }
        let post = client
            .post(format!("{anchor_url}{path}"))
            .send()
            .await
            .unwrap();
        assert_eq!(post.text().await.unwrap(), "upstream response");
        assert_eq!(upstream_calls.load(Ordering::Relaxed), 3);

        anchor_handle.abort();
        authority_handle.abort();
    }

    #[tokio::test]
    async fn anchor_forwards_method_path_query_body_and_auth() {
        let (authority_url, authority_handle) = spawn_authority().await;
        let (anchor_url, anchor_handle) = spawn_anchor(authority_url).await;

        let response: Value = reqwest::Client::new()
            .post(format!("{anchor_url}/api/messages?channel=general"))
            .bearer_auth("test-token")
            .header("x-forwarded-for", "198.51.100.20")
            .header("forwarded", "for=198.51.100.20")
            .body("hello anchor")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        assert_eq!(response["method"], "POST");
        assert_eq!(response["pathAndQuery"], "/api/messages?channel=general");
        assert_eq!(response["authorization"], "Bearer test-token");
        assert_eq!(response["forwardedFor"], "127.0.0.1");
        assert!(response["forwarded"].is_null());
        assert_eq!(response["body"], "hello anchor");

        anchor_handle.abort();
        authority_handle.abort();
    }

    #[tokio::test]
    async fn trusted_proxy_anchor_authority_preserves_client_limits_without_forwarding_spoofs() {
        let authority_policy = TrustedProxyConfig::from_trusted_proxies(vec![
            "127.0.0.0/8".parse().unwrap(),
            "10.0.0.0/8".parse().unwrap(),
        ]);
        let authority_limiter =
            crate::rate_limit::RateLimitState::new(1, 1).from_trusted_proxies(vec![
                "127.0.0.0/8".parse().unwrap(),
                "10.0.0.0/8".parse().unwrap(),
            ]);
        let authority = Router::new()
            .route(
                "/api/users/{id}",
                get(move |headers: HeaderMap, ConnectInfo(peer): ConnectInfo<SocketAddr>| {
                    let policy = authority_policy.clone();
                    async move {
                        Json(json!({
                            "client": policy.client_ip(&headers, peer).to_string(),
                            "forwardedFor": headers["x-forwarded-for"].to_str().unwrap(),
                            "forwarded": headers.get("forwarded").and_then(|value| value.to_str().ok()),
                        }))
                    }
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                authority_limiter,
                crate::rate_limit::rate_limit_middleware,
            ));
        let (authority_url, authority_handle) = spawn_anchor_router(authority).await;
        let mut state = AnchorState::new_with_cache_bytes(authority_url, 0).unwrap();
        state.trusted_proxies =
            TrustedProxyConfig::from_trusted_proxies(vec!["10.0.0.0/8".parse().unwrap()]);
        let app = create_router(Arc::new(state));

        for (path, peer, xff, expected, client, forwarded) in [
            (
                "/api/users/one",
                "10.0.0.2:4567",
                "198.51.100.99, 198.51.100.20, 10.0.0.1",
                StatusCode::OK,
                "198.51.100.20",
                "198.51.100.20, 10.0.0.2",
            ),
            (
                "/api/users/two",
                "10.0.0.2:4567",
                "198.51.100.98, 198.51.100.20, 10.0.0.1",
                StatusCode::TOO_MANY_REQUESTS,
                "",
                "",
            ),
            (
                "/api/users/three",
                "10.0.0.2:4567",
                "198.51.100.99, 198.51.100.21, 10.0.0.1",
                StatusCode::OK,
                "198.51.100.21",
                "198.51.100.21, 10.0.0.2",
            ),
            (
                "/api/users/four",
                "192.0.2.50:4567",
                "198.51.100.22",
                StatusCode::OK,
                "192.0.2.50",
                "192.0.2.50",
            ),
            (
                "/api/users/five",
                "192.0.2.50:4567",
                "198.51.100.23",
                StatusCode::TOO_MANY_REQUESTS,
                "",
                "",
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::get(path)
                        .header("x-forwarded-for", xff)
                        .header("forwarded", "for=198.51.100.200")
                        .extension(ConnectInfo(peer.parse::<SocketAddr>().unwrap()))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            if expected == StatusCode::OK {
                let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
                let value: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(value["client"], client);
                assert_eq!(value["forwardedFor"], forwarded);
                assert!(value["forwarded"].is_null());
            }
        }
        // The alternative header family resolves to the same canonical
        // identity and cannot provide a second budget for the first member.
        for (client, expected) in [
            ("198.51.100.20", StatusCode::TOO_MANY_REQUESTS),
            ("198.51.100.22", StatusCode::OK),
        ] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::get("/api/users/forwarded")
                        .header("forwarded", "for=198.51.100.99;proto=https")
                        .header("forwarded", format!("for={client};proto=https"))
                        .extension(ConnectInfo("10.0.0.2:4567".parse::<SocketAddr>().unwrap()))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            if expected == StatusCode::OK {
                let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
                let value: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(value["client"], client);
                assert_eq!(value["forwardedFor"], format!("{client}, 10.0.0.2"));
                assert!(value["forwarded"].is_null());
            }
        }
        authority_handle.abort();
    }

    #[tokio::test]
    async fn anchor_returns_unavailable_when_authority_is_down() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let authority_url = format!("http://{}", addr);
        let (anchor_url, anchor_handle) = spawn_anchor_router(create_router(Arc::new(
            AnchorState::new_with_cache_bytes(authority_url.clone(), 1024).unwrap(),
        )))
        .await;

        for path in ["/api/channels", "/uploads/art.bin"] {
            let response = reqwest::Client::new()
                .get(format!("{anchor_url}{path}"))
                .send()
                .await
                .unwrap();

            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            let text = response.text().await.unwrap();
            let body: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(body["error"], "authority unavailable");
            assert!(body.get("detail").is_none());
            assert!(!text.contains(&authority_url));
            assert!(!text.contains(&addr.to_string()));
        }

        anchor_handle.abort();
    }

    #[tokio::test]
    async fn anchor_does_not_follow_authority_redirects_with_forwarded_credentials() {
        let redirected_calls = Arc::new(AtomicUsize::new(0));
        let calls = redirected_calls.clone();
        let (redirect_url, redirect_handle) = spawn_router(Router::new().fallback(move || {
            let calls = calls.clone();
            async move {
                calls.fetch_add(1, Ordering::Relaxed);
                "redirect was followed"
            }
        }))
        .await;
        let location = format!("{redirect_url}/private");
        let upstream_location = location.clone();
        let (authority_url, authority_handle) = spawn_router(Router::new().route(
            "/redirect",
            get(move || {
                let location = upstream_location.clone();
                async move {
                    (
                        StatusCode::TEMPORARY_REDIRECT,
                        [(header::LOCATION, location)],
                    )
                }
            }),
        ))
        .await;
        let (anchor_url, anchor_handle) = spawn_anchor(authority_url).await;
        let response = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
            .get(format!("{anchor_url}/redirect"))
            .bearer_auth("community-session")
            .header(header::COOKIE, "session=private")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(response.headers()[header::LOCATION], location);
        assert_eq!(redirected_calls.load(Ordering::Relaxed), 0);
        anchor_handle.abort();
        authority_handle.abort();
        redirect_handle.abort();
    }

    #[tokio::test]
    async fn anchor_streams_response_before_upstream_finishes() {
        let (sender, receiver) = tokio::sync::mpsc::channel::<Bytes>(2);
        let receiver = Arc::new(tokio::sync::Mutex::new(Some(receiver)));
        let app = Router::new().route(
            "/stream",
            get(move || {
                let receiver = Arc::clone(&receiver);
                async move {
                    let receiver = receiver.lock().await.take().unwrap();
                    Body::from_stream(futures::stream::unfold(
                        receiver,
                        |mut receiver| async move {
                            receiver
                                .recv()
                                .await
                                .map(|bytes| (Ok::<Bytes, Infallible>(bytes), receiver))
                        },
                    ))
                }
            }),
        );
        let (authority_url, authority_handle) = spawn_router(app).await;
        let (anchor_url, anchor_handle) = spawn_anchor(authority_url).await;

        sender.send(Bytes::from_static(b"first")).await.unwrap();
        let response = tokio::time::timeout(
            Duration::from_secs(2),
            reqwest::Client::new()
                .get(format!("{anchor_url}/stream"))
                .send(),
        )
        .await
        .unwrap()
        .unwrap();
        let mut chunks = response.bytes_stream();
        let first = tokio::time::timeout(Duration::from_secs(2), chunks.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(first, "first");

        sender.send(Bytes::from_static(b"second")).await.unwrap();
        drop(sender);
        let second = chunks.next().await.unwrap().unwrap();
        assert_eq!(second, "second");
        assert!(chunks.next().await.is_none());

        anchor_handle.abort();
        authority_handle.abort();
    }

    #[tokio::test]
    async fn anchor_streams_upload_to_authority_before_client_finishes() {
        let (first_seen_sender, first_seen_receiver) = tokio::sync::oneshot::channel();
        let first_seen_sender = Arc::new(tokio::sync::Mutex::new(Some(first_seen_sender)));
        let app = Router::new().route(
            "/upload",
            post(move |body: Body| {
                let first_seen_sender = Arc::clone(&first_seen_sender);
                async move {
                    let mut chunks = body.into_data_stream();
                    let first = chunks.next().await.unwrap().unwrap();
                    first_seen_sender
                        .lock()
                        .await
                        .take()
                        .unwrap()
                        .send(())
                        .unwrap();
                    let second = chunks.next().await.unwrap().unwrap();
                    format!(
                        "{}{}",
                        String::from_utf8_lossy(&first),
                        String::from_utf8_lossy(&second)
                    )
                }
            }),
        );
        let (authority_url, authority_handle) = spawn_router(app).await;
        let (anchor_url, anchor_handle) = spawn_anchor(authority_url).await;

        let (sender, receiver) = tokio::sync::mpsc::channel::<Bytes>(2);
        let stream = futures::stream::unfold(receiver, |mut receiver| async move {
            receiver
                .recv()
                .await
                .map(|bytes| (Ok::<Bytes, Infallible>(bytes), receiver))
        });
        let request = tokio::spawn(async move {
            reqwest::Client::new()
                .post(format!("{anchor_url}/upload"))
                .body(reqwest::Body::wrap_stream(stream))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap()
        });
        sender.send(Bytes::from_static(b"first")).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), first_seen_receiver)
            .await
            .unwrap()
            .unwrap();
        sender.send(Bytes::from_static(b"second")).await.unwrap();
        drop(sender);
        assert_eq!(request.await.unwrap(), "firstsecond");

        anchor_handle.abort();
        authority_handle.abort();
    }

    #[tokio::test]
    async fn anchor_bridges_websocket_query_auth_and_messages() {
        async fn echo(
            ws: WebSocketUpgrade,
            headers: HeaderMap,
            OriginalUri(uri): OriginalUri,
        ) -> Response {
            let auth = headers
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            assert_eq!(headers["x-forwarded-for"], "127.0.0.1");
            assert!(!headers.contains_key("forwarded"));
            assert!(!headers.contains_key("x-real-ip"));
            let path = uri.path_and_query().unwrap().as_str().to_owned();
            ws.on_upgrade(move |mut socket| async move {
                socket
                    .send(Message::Text(format!("{auth} {path}").into()))
                    .await
                    .unwrap();
                if let Some(Ok(message)) = socket.recv().await {
                    socket.send(message).await.unwrap();
                }
            })
            .into_response()
        }

        let (authority_url, authority_handle) =
            spawn_router(Router::new().route("/socket.io/", get(echo))).await;
        let (anchor_url, anchor_handle) = spawn_anchor(authority_url).await;
        let mut request = format!(
            "ws://{}/socket.io/?EIO=4&transport=websocket",
            anchor_url.trim_start_matches("http://")
        )
        .into_client_request()
        .unwrap();
        request
            .headers_mut()
            .insert(header::AUTHORIZATION, "Bearer test-token".parse().unwrap());
        request
            .headers_mut()
            .insert("x-forwarded-for", "198.51.100.20".parse().unwrap());
        request
            .headers_mut()
            .insert("forwarded", "for=198.51.100.20".parse().unwrap());
        request
            .headers_mut()
            .insert("x-real-ip", "198.51.100.20".parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        let greeting = socket.next().await.unwrap().unwrap();
        assert_eq!(
            greeting.to_text().unwrap(),
            "Bearer test-token /socket.io/?EIO=4&transport=websocket"
        );
        socket
            .send(UpstreamMessage::Text("ping".into()))
            .await
            .unwrap();
        let echoed = socket.next().await.unwrap().unwrap();
        assert_eq!(echoed.to_text().unwrap(), "ping");

        socket.close(None).await.unwrap();
        anchor_handle.abort();
        authority_handle.abort();
    }

    #[tokio::test]
    async fn anchor_preserves_websocket_close_reason() {
        async fn close_with_reason(ws: WebSocketUpgrade) -> Response {
            ws.on_upgrade(|mut socket| async move {
                socket
                    .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                        code: 4001,
                        reason: "session expired".into(),
                    })))
                    .await
                    .unwrap();
            })
            .into_response()
        }

        let (authority_url, authority_handle) =
            spawn_router(Router::new().route("/socket.io/", get(close_with_reason))).await;
        let (anchor_url, anchor_handle) = spawn_anchor(authority_url).await;
        let websocket_url = format!(
            "ws://{}/socket.io/?EIO=4&transport=websocket",
            anchor_url.trim_start_matches("http://")
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(websocket_url)
            .await
            .unwrap();
        let close = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        match close {
            UpstreamMessage::Close(Some(frame)) => {
                assert_eq!(u16::from(frame.code), 4001);
                assert_eq!(frame.reason.as_str(), "session expired");
            }
            other => panic!("expected the Authority close reason, got {other:?}"),
        }

        anchor_handle.abort();
        authority_handle.abort();
    }

    #[tokio::test]
    async fn anchor_forwards_client_websocket_close_reason() {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let sender = Arc::new(tokio::sync::Mutex::new(Some(sender)));
        let app = Router::new().route(
            "/socket.io/",
            get(move |ws: WebSocketUpgrade| {
                let sender = Arc::clone(&sender);
                async move {
                    ws.on_upgrade(move |mut socket| async move {
                        if let Some(Ok(Message::Close(Some(frame)))) = socket.recv().await {
                            let _ = sender
                                .lock()
                                .await
                                .take()
                                .unwrap()
                                .send((frame.code, frame.reason.to_string()));
                        }
                    })
                }
            }),
        );
        let (authority_url, authority_handle) = spawn_router(app).await;
        let (anchor_url, anchor_handle) = spawn_anchor(authority_url).await;
        let websocket_url = format!(
            "ws://{}/socket.io/?EIO=4&transport=websocket",
            anchor_url.trim_start_matches("http://")
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(websocket_url)
            .await
            .unwrap();
        socket
            .close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: 4002.into(),
                reason: "client switching site".into(),
            }))
            .await
            .unwrap();
        let (code, reason) = tokio::time::timeout(Duration::from_secs(2), receiver)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(code, 4002);
        assert_eq!(reason, "client switching site");

        anchor_handle.abort();
        authority_handle.abort();
    }

    #[tokio::test]
    async fn anchor_preserves_upstream_websocket_rejection_status() {
        let app = Router::new().route("/socket.io/", get(|| async { StatusCode::UNAUTHORIZED }));
        let (authority_url, authority_handle) = spawn_router(app).await;
        let (anchor_url, anchor_handle) = spawn_anchor(authority_url.clone()).await;
        let request = format!(
            "ws://{}/socket.io/?EIO=4&transport=websocket",
            anchor_url.trim_start_matches("http://")
        );
        let error = tokio_tungstenite::connect_async(request).await.unwrap_err();
        match error {
            tokio_tungstenite::tungstenite::Error::Http(response) => {
                assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
                let body = response.body().as_ref().expect("rejection has JSON body");
                let text = String::from_utf8_lossy(body);
                let body: Value = serde_json::from_slice(body).unwrap();
                assert!(body.get("detail").is_none());
                assert!(!text.contains(&authority_url));
            }
            other => panic!("expected upstream rejection, got {other}"),
        }

        anchor_handle.abort();
        authority_handle.abort();
    }

    #[tokio::test]
    async fn anchor_websocket_unavailable_response_hides_private_upstream() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let authority_url = format!("http://{addr}");
        let (anchor_url, anchor_handle) = spawn_anchor(authority_url.clone()).await;
        let request = format!(
            "ws://{}/socket.io/?EIO=4&transport=websocket",
            anchor_url.trim_start_matches("http://")
        );
        match tokio_tungstenite::connect_async(request).await.unwrap_err() {
            tokio_tungstenite::tungstenite::Error::Http(response) => {
                assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
                let bytes = response.body().as_ref().expect("rejection has JSON body");
                let text = String::from_utf8_lossy(bytes);
                let body: Value = serde_json::from_slice(bytes).unwrap();
                assert_eq!(body["error"], "authority unavailable");
                assert!(body.get("detail").is_none());
                assert!(!text.contains(&authority_url));
                assert!(!text.contains(&addr.to_string()));
            }
            other => panic!("expected upstream failure, got {other}"),
        }
        anchor_handle.abort();
    }

    #[tokio::test]
    async fn anchor_carries_engine_io_polling_and_websocket() {
        let (layer, io) = socketioxide::SocketIo::new_layer();
        io.ns("/", |_: socketioxide::extract::SocketRef| {});
        let (authority_url, authority_handle) = spawn_router(Router::new().layer(layer)).await;
        let (anchor_url, anchor_handle) = spawn_anchor(authority_url).await;

        let polling = reqwest::Client::new()
            .get(format!("{anchor_url}/socket.io/?EIO=4&transport=polling"))
            .send()
            .await
            .unwrap();
        assert!(polling.status().is_success());
        assert!(polling.text().await.unwrap().starts_with("0{"));

        let websocket_url = format!(
            "ws://{}/socket.io/?EIO=4&transport=websocket",
            anchor_url.trim_start_matches("http://")
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(websocket_url)
            .await
            .unwrap();
        let open = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(open.to_text().unwrap().starts_with("0{"));
        socket
            .send(UpstreamMessage::Text("40".into()))
            .await
            .unwrap();
        let mut joined = false;
        for _ in 0..3 {
            let packet = tokio::time::timeout(Duration::from_secs(2), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            match packet.to_text().unwrap() {
                "2" => socket
                    .send(UpstreamMessage::Text("3".into()))
                    .await
                    .unwrap(),
                text if text.starts_with("40") => {
                    joined = true;
                    break;
                }
                other => panic!("unexpected Socket.IO packet: {other}"),
            }
        }
        assert!(joined, "Socket.IO namespace did not connect through Anchor");

        socket.close(None).await.unwrap();
        anchor_handle.abort();
        authority_handle.abort();
    }
}
