//! Stateless regional anchor proxy.
//!
//! Anchor mode is intentionally not a replica. It forwards requests to the
//! authority, preserves method/path/query/body/auth headers, and fails fast when
//! the authority is unreachable. It does not require or initialize STDB.

use axum::{
    body::Bytes,
    extract::{OriginalUri, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct AnchorState {
    authority_url: String,
    client: reqwest::Client,
}

impl AnchorState {
    pub fn new(authority_url: String) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(10))
            .build()?;
        Ok(Self {
            authority_url: authority_url.trim_end_matches('/').to_string(),
            client,
        })
    }
}

pub fn create_anchor_router(authority_url: String) -> anyhow::Result<Router> {
    let state = Arc::new(AnchorState::new(authority_url)?);
    Ok(Router::new()
        .route("/health", get(anchor_health))
        .fallback(proxy_to_authority)
        .with_state(state))
}

async fn anchor_health(State(state): State<Arc<AnchorState>>) -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "service": "wabi-server",
        "role": "anchor",
        "authorityUrl": state.authority_url,
        "version": env!("CARGO_PKG_VERSION"),
        "timestamp": chrono::Utc::now().to_rfc3339()
    }))
}

async fn proxy_to_authority(
    State(state): State<Arc<AnchorState>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match forward(&state, method, uri, headers, body).await {
        Ok(response) => response,
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "authority unavailable",
                "role": "anchor",
                "detail": error.to_string()
            })),
        )
            .into_response(),
    }
}

async fn forward(
    state: &AnchorState,
    method: Method,
    uri: axum::http::Uri,
    headers: HeaderMap,
    body: Bytes,
) -> anyhow::Result<Response> {
    let target = target_url(&state.authority_url, &uri);
    let reqwest_method = reqwest::Method::from_bytes(method.as_str().as_bytes())?;
    let mut request = state
        .client
        .request(reqwest_method, target)
        .body(body.to_vec());

    for (name, value) in headers.iter() {
        if is_hop_by_hop_header(name.as_str()) || name.as_str().eq_ignore_ascii_case("host") {
            continue;
        }
        request = request.header(name, value);
    }

    let upstream = request.send().await?;
    let status = StatusCode::from_u16(upstream.status().as_u16())?;
    let mut builder = Response::builder().status(status);
    for (name, value) in upstream.headers().iter() {
        if is_hop_by_hop_header(name.as_str()) {
            continue;
        }
        builder = builder.header(name, value);
    }
    let bytes = upstream.bytes().await?;
    Ok(builder.body(axum::body::Body::from(bytes))?)
}

fn target_url(authority_url: &str, uri: &axum::http::Uri) -> String {
    let path_and_query = uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
    format!("{}{}", authority_url.trim_end_matches('/'), path_and_query)
}

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
    use axum::{extract::OriginalUri, routing::any, Json, Router};
    use serde_json::Value;
    use tokio::net::TcpListener;

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
                "body": String::from_utf8_lossy(&body),
            }))
        }

        let app = Router::new().fallback(any(echo));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{}", addr), handle)
    }

    async fn spawn_anchor(authority_url: String) -> (String, tokio::task::JoinHandle<()>) {
        let app = create_anchor_router(authority_url).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{}", addr), handle)
    }

    #[tokio::test]
    async fn anchor_forwards_method_path_query_body_and_auth() {
        let (authority_url, authority_handle) = spawn_authority().await;
        let (anchor_url, anchor_handle) = spawn_anchor(authority_url).await;

        let response: Value = reqwest::Client::new()
            .post(format!("{anchor_url}/api/messages?channel=general"))
            .bearer_auth("test-token")
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
        assert_eq!(response["body"], "hello anchor");

        anchor_handle.abort();
        authority_handle.abort();
    }

    #[tokio::test]
    async fn anchor_returns_unavailable_when_authority_is_down() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let (anchor_url, anchor_handle) = spawn_anchor(format!("http://{}", addr)).await;

        let response = reqwest::Client::new()
            .get(format!("{anchor_url}/api/channels"))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["error"], "authority unavailable");

        anchor_handle.abort();
    }
}
