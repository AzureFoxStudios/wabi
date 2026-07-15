use axum::{
    extract::State,
    http::{header::FORWARDED, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use governor::{DefaultDirectRateLimiter, Quota, RateLimiter};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct RateLimitState {
    limiters: Arc<RwLock<HashMap<String, Arc<DefaultDirectRateLimiter>>>>,
    default_quota: Quota,
}

impl RateLimitState {
    pub fn new(requests_per_second: u32, burst: u32) -> Self {
        let quota = Quota::per_second(
            std::num::NonZeroU32::new(requests_per_second)
                .unwrap_or(std::num::NonZeroU32::new(10).unwrap()),
        )
        .allow_burst(
            std::num::NonZeroU32::new(burst).unwrap_or(std::num::NonZeroU32::new(20).unwrap()),
        );

        Self {
            limiters: Arc::new(RwLock::new(HashMap::new())),
            default_quota: quota,
        }
    }

    async fn get_limiter(&self, key: &str) -> Arc<DefaultDirectRateLimiter> {
        let mut limiters = self.limiters.write().await;
        limiters
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(RateLimiter::direct(self.default_quota.clone())))
            .clone()
    }

    fn extract_client_ip(headers: &HeaderMap) -> String {
        headers
            .get(FORWARDED)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| {
                s.split(',')
                    .next()
                    .and_then(|part| part.split(';').next())
                    .and_then(|kv| kv.split('=').nth(1))
                    .map(|ip| ip.trim().trim_matches('"').to_string())
            })
            .or_else(|| {
                headers
                    .get("x-forwarded-for")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.split(',').next().map(|ip| ip.trim().to_string()))
            })
            .or_else(|| {
                headers
                    .get("x-real-ip")
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.trim().to_string())
            })
            .unwrap_or_else(|| "unknown".to_string())
    }

    pub async fn check_rate_limit(&self, headers: &HeaderMap, path: &str) -> Result<(), Response> {
        let ip = Self::extract_client_ip(headers);
        let key = format!("{}:{}", ip, path);

        let limiter = self.get_limiter(&key).await;

        if limiter.check().is_err() {
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({
                    "error": "Rate limit exceeded. Please slow down.",
                    "type": "RateLimitExceeded"
                })),
            )
                .into_response());
        }

        Ok(())
    }
}

pub async fn rate_limit_middleware(
    State(rate_limit_state): State<RateLimitState>,
    headers: HeaderMap,
    request: axum::http::Request<axum::body::Body>,
    next: Next,
) -> Response {
    let path = request.uri().path().to_string();

    if let Err(response) = rate_limit_state.check_rate_limit(&headers, &path).await {
        return response;
    }

    next.run(request).await
}
