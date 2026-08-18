use axum::{
    extract::{ConnectInfo, State},
    http::{header::FORWARDED, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use governor::{DefaultDirectRateLimiter, Quota, RateLimiter};
use serde_json::json;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct RateLimitState {
    limiters: Arc<RwLock<HashMap<String, Arc<DefaultDirectRateLimiter>>>>,
    default_quota: Quota,
    /// Trusted proxy CIDRs. Empty means no trusted proxies — client IP = socket peer.
    trusted_proxies: Vec<ipnet::IpNet>,
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
            trusted_proxies: Vec::new(),
        }
    }

    /// Set trusted proxy CIDRs from the WABI_TRUSTED_PROXIES env var.
    pub fn with_trusted_proxies(mut self) -> Self {
        if let Ok(val) = std::env::var("WABI_TRUSTED_PROXIES") {
            self.trusted_proxies = val
                .split(',')
                .filter_map(|s| s.trim().parse::<ipnet::IpNet>().ok())
                .collect();
        }
        self
    }

    async fn get_limiter(&self, key: &str) -> Arc<DefaultDirectRateLimiter> {
        let mut limiters = self.limiters.write().await;
        // Bound the limiter map: retain only recently-used keys.
        if limiters.len() > 10_000 {
            // Simple eviction: drain half the map.
            let keys: Vec<String> = limiters.keys().take(limiters.len() / 2).cloned().collect();
            for k in keys {
                limiters.remove(&k);
            }
        }
        limiters
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(RateLimiter::direct(self.default_quota.clone())))
            .clone()
    }

    /// Extract the client IP, respecting trusted proxies.
    /// Empty trusted_proxies: client IP = socket peer address (headers ignored).
    /// Non-empty + peer trusted: use the rightmost untrusted XFF entry.
    /// Non-empty + peer untrusted: client IP = socket peer address.
    fn extract_client_ip(&self, headers: &HeaderMap, peer: SocketAddr) -> String {
        let peer_ip = peer.ip();
        if self.trusted_proxies.is_empty() {
            // No trusted proxies configured — ignore all forwarding headers.
            return peer_ip.to_string();
        }

        // Check if the peer is a trusted proxy.
        let peer_trusted = self.trusted_proxies.iter().any(|net| net.contains(&peer_ip));
        if !peer_trusted {
            return peer_ip.to_string();
        }

        // Peer is trusted — parse the rightmost untrusted XFF entry.
        if let Some(xff) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
        {
            let mut ip_str: Option<String> = None;
            for entry in xff.split(',').rev() {
                let candidate = entry.trim();
                if let Ok(ip) = candidate.parse::<std::net::IpAddr>() {
                    // Skip trusted proxies; take the first (rightmost) untrusted entry.
                    let is_trusted = self.trusted_proxies.iter().any(|net| net.contains(&ip));
                    if !is_trusted {
                        ip_str = Some(candidate.to_string());
                        break;
                    }
                }
            }
            if let Some(ip) = ip_str {
                return ip;
            }
        }

        // Fallback: use the Forwarded header.
        if let Some(fwd) = headers.get(FORWARDED).and_then(|v| v.to_str().ok()) {
            if let Some(for_val) = fwd.split(';').find_map(|part| {
                part.trim().strip_prefix("for=").map(|s| {
                    s.trim()
                        .trim_matches('"')
                        .trim_start_matches('[')
                        .trim_end_matches(']')
                })
            }) {
                return for_val.to_string();
            }
        }

        peer_ip.to_string()
    }

    pub async fn check_rate_limit(
        &self,
        headers: &HeaderMap,
        peer: SocketAddr,
        path: &str,
    ) -> Result<(), Response> {
        let ip = self.extract_client_ip(headers, peer);
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
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    request: axum::http::Request<axum::body::Body>,
    next: Next,
) -> Response {
    let path = request.uri().path().to_string();

    if let Err(response) = rate_limit_state
        .check_rate_limit(&headers, peer, &path)
        .await
    {
        return response;
    }

    next.run(request).await
}
