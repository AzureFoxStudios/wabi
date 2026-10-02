use axum::{
    extract::{ConnectInfo, MatchedPath, State},
    http::{header::FORWARDED, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use governor::{
    clock::Clock, middleware::NoOpMiddleware, state::keyed::DefaultKeyedStateStore,
    DefaultKeyedRateLimiter, Quota, RateLimiter,
};
use serde_json::json;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const CLEANUP_INTERVAL: Duration = Duration::from_secs(60);
const UNMATCHED_ROUTE: &str = "<unmatched>";
type RateLimitKey = (IpAddr, String);
type KeyedLimiter<C> = RateLimiter<
    RateLimitKey,
    DefaultKeyedStateStore<RateLimitKey>,
    C,
    NoOpMiddleware<<C as Clock>::Instant>,
>;

fn cleanup_if_due<C: Clock>(limiter: &KeyedLimiter<C>, last_cleanup: &Mutex<Instant>) {
    let mut last_cleanup = last_cleanup.lock().unwrap_or_else(|e| e.into_inner());
    if last_cleanup.elapsed() >= CLEANUP_INTERVAL {
        // Governor removes only buckets that have completely refilled.
        // Evicting arbitrary active keys would give them a fresh burst.
        limiter.retain_recent();
        *last_cleanup = Instant::now();
    }
}

#[derive(Clone)]
pub struct RateLimitState {
    limiter: Arc<DefaultKeyedRateLimiter<(IpAddr, String)>>,
    last_cleanup: Arc<Mutex<Instant>>,
    trusted_proxies: TrustedProxyConfig,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct TrustedProxyConfig {
    /// Only proxies controlled by the operator may supply forwarding headers.
    proxies: Vec<ipnet::IpNet>,
}

impl TrustedProxyConfig {
    pub(crate) fn from_env() -> Self {
        Self {
            proxies: std::env::var("WABI_TRUSTED_PROXIES")
                .unwrap_or_default()
                .split(',')
                .filter_map(|value| value.trim().parse().ok())
                .collect(),
        }
    }

    #[cfg(test)]
    pub(crate) fn from_trusted_proxies(proxies: Vec<ipnet::IpNet>) -> Self {
        Self { proxies }
    }

    /// Extract the client IP, respecting trusted proxies.
    /// Empty trusted_proxies: client IP = socket peer address (headers ignored).
    /// Non-empty + peer trusted: use the rightmost untrusted XFF entry.
    /// Non-empty + peer untrusted: client IP = socket peer address.
    pub(crate) fn client_ip(&self, headers: &HeaderMap, peer: SocketAddr) -> IpAddr {
        let peer_ip = peer.ip();
        if self.proxies.is_empty() {
            // No trusted proxies configured — ignore all forwarding headers.
            return peer_ip;
        }

        // Check if the peer is a trusted proxy.
        let peer_trusted = self.proxies.iter().any(|net| net.contains(&peer_ip));
        if !peer_trusted {
            return peer_ip;
        }

        // Repeated header fields are one ordered chain. A trusted proxy may
        // append a separate field after a caller-supplied one.
        if headers.contains_key("x-forwarded-for") {
            for value in headers.get_all("x-forwarded-for").iter().rev() {
                let Ok(xff) = value.to_str() else {
                    return peer_ip;
                };
                for entry in xff.split(',').rev() {
                    let Ok(ip) = entry.trim().parse::<IpAddr>() else {
                        return peer_ip;
                    };
                    if !self.proxies.iter().any(|net| net.contains(&ip)) {
                        return ip;
                    }
                }
            }
            // An ambiguous/all-trusted XFF cannot be overridden by Forwarded.
            return peer_ip;
        }

        // Without XFF, apply the same right-to-left trust rule to Forwarded.
        for value in headers.get_all(FORWARDED).iter().rev() {
            let Ok(forwarded) = value.to_str() else {
                return peer_ip;
            };
            for element in forwarded.split(',').rev() {
                let mut for_values = element.split(';').filter_map(|part| {
                    let (name, value) = part.trim().split_once('=')?;
                    name.eq_ignore_ascii_case("for").then_some(value.trim())
                });
                let Some(value) = for_values.next() else {
                    return peer_ip;
                };
                if for_values.next().is_some() {
                    return peer_ip;
                }
                let Some(ip) = forwarded_ip(value) else {
                    return peer_ip;
                };
                if !self.proxies.iter().any(|net| net.contains(&ip)) {
                    return ip;
                }
            }
        }

        peer_ip
    }
}

fn forwarded_ip(value: &str) -> Option<IpAddr> {
    let value = if value.starts_with('"') {
        value.strip_prefix('"')?.strip_suffix('"')?
    } else {
        value
    };
    value
        .parse::<IpAddr>()
        .ok()
        .or_else(|| value.parse::<SocketAddr>().ok().map(|address| address.ip()))
        .or_else(|| value.strip_prefix('[')?.strip_suffix(']')?.parse().ok())
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
            limiter: Arc::new(RateLimiter::keyed(quota)),
            last_cleanup: Arc::new(Mutex::new(Instant::now())),
            trusted_proxies: TrustedProxyConfig::default(),
        }
    }

    pub fn with_trusted_proxies(mut self) -> Self {
        self.trusted_proxies = TrustedProxyConfig::from_env();
        self
    }

    #[cfg(test)]
    pub(crate) fn from_trusted_proxies(mut self, proxies: Vec<ipnet::IpNet>) -> Self {
        self.trusted_proxies = TrustedProxyConfig::from_trusted_proxies(proxies);
        self
    }

    fn cleanup_if_due(&self) {
        cleanup_if_due(self.limiter.as_ref(), &self.last_cleanup);
    }

    pub async fn check_rate_limit(
        &self,
        headers: &HeaderMap,
        peer: SocketAddr,
        route: &str,
    ) -> Result<(), Response> {
        let ip = self.trusted_proxies.client_ip(headers, peer);
        let key = (ip, route.to_owned());
        self.cleanup_if_due();

        if self.limiter.check_key(&key).is_err() {
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

/// Admission IP denies share the rate limiter's trusted-proxy interpretation.
/// A direct peer's forwarding headers cannot change its identity.
pub fn trusted_client_ip(headers: &HeaderMap, peer: SocketAddr) -> String {
    TrustedProxyConfig::from_env()
        .client_ip(headers, peer)
        .to_string()
}

pub async fn rate_limit_middleware(
    State(rate_limit_state): State<RateLimitState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    request: axum::http::Request<axum::body::Body>,
    next: Next,
) -> Response {
    // A cold SPA load needs more requests than the API burst allows. Exempt
    // only GET/HEAD files verified against this build's immutable assets;
    // arbitrary fallback paths and missing asset versions stay rate limited.
    if request.extensions().get::<MatchedPath>().is_none()
        && crate::app_router::embedded_immutable_asset(request.method(), request.uri()).is_some()
    {
        return next.run(request).await;
    }
    // Router middleware runs after route matching. Parameters and fallback
    // paths must share their allowance instead of creating a bucket per URL.
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str)
        .unwrap_or(UNMATCHED_ROUTE);

    if let Err(response) = rate_limit_state
        .check_rate_limit(&headers, peer, route)
        .await
    {
        return response;
    }

    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request, routing::get, Router};
    use tower::ServiceExt;

    async fn request(app: &Router, path: &str, peer: &str) -> StatusCode {
        app.clone()
            .oneshot(
                Request::get(path)
                    .extension(ConnectInfo(peer.parse::<SocketAddr>().unwrap()))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
            .status()
    }

    fn test_router(state: RateLimitState) -> Router {
        Router::new()
            .nest(
                "/api",
                Router::new()
                    .route("/channels/{channel}/messages/{id}", get(|| async { "ok" }))
                    .route("/users/{id}", get(|| async { "ok" })),
            )
            .route("/uploads/{filename}", get(|| async { "ok" }))
            .fallback(|| async { "fallback" })
            .layer(axum::middleware::from_fn_with_state(
                state,
                rate_limit_middleware,
            ))
    }

    #[tokio::test]
    async fn changing_nested_parameters_upload_names_and_unmatched_paths_cannot_reset_burst() {
        let state = RateLimitState::new(1, 1);
        let app = test_router(state.clone());
        for (first, second) in [
            (
                "/api/channels/general/messages/1",
                "/api/channels/random/messages/2?nonce=another",
            ),
            ("/uploads/one.png", "/uploads/two.png"),
            ("/unknown/one", "/unknown/two"),
        ] {
            assert_eq!(request(&app, first, "192.0.2.1:1234").await, StatusCode::OK);
            assert_eq!(
                request(&app, second, "192.0.2.1:5678").await,
                StatusCode::TOO_MANY_REQUESTS,
                "changing the concrete path must retain the template allowance"
            );
        }
        assert_eq!(state.limiter.len(), 3);
    }

    #[tokio::test]
    async fn separate_route_templates_and_client_addresses_keep_independent_bursts() {
        let state = RateLimitState::new(1, 1);
        let app = test_router(state.clone());
        assert_eq!(
            request(&app, "/api/users/one", "192.0.2.1:1234").await,
            StatusCode::OK
        );
        assert_eq!(
            request(&app, "/api/users/two", "192.0.2.1:5678").await,
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            request(&app, "/api/channels/general/messages/1", "192.0.2.1:1234").await,
            StatusCode::OK
        );
        assert_eq!(
            request(&app, "/api/users/two", "192.0.2.2:1234").await,
            StatusCode::OK
        );
        assert_eq!(state.limiter.len(), 3);
    }

    #[tokio::test]
    async fn timed_cleanup_does_not_refresh_an_exhausted_bucket() {
        let state = RateLimitState::new(1, 1);
        let peer = "192.0.2.1:1234".parse().unwrap();
        assert!(state
            .check_rate_limit(&HeaderMap::new(), peer, "/api/users/{id}")
            .await
            .is_ok());
        *state.last_cleanup.lock().unwrap() = Instant::now() - CLEANUP_INTERVAL;
        assert!(state
            .check_rate_limit(&HeaderMap::new(), peer, "/api/users/{id}")
            .await
            .is_err());
        assert_eq!(state.limiter.len(), 1);
        assert!(state.last_cleanup.lock().unwrap().elapsed() < CLEANUP_INTERVAL);
    }

    #[test]
    fn timed_cleanup_removes_fully_refilled_idle_buckets() {
        let clock = governor::clock::FakeRelativeClock::default();
        let limiter: KeyedLimiter<_> = RateLimiter::dashmap_with_clock(
            Quota::per_second(std::num::NonZeroU32::new(1).unwrap()),
            &clock,
        );
        let key = ("192.0.2.1".parse().unwrap(), "/api/users/{id}".into());
        assert!(limiter.check_key(&key).is_ok());
        assert!(limiter.check_key(&key).is_err());
        let last_cleanup = Mutex::new(Instant::now() - CLEANUP_INTERVAL);
        cleanup_if_due(&limiter, &last_cleanup);
        assert_eq!(limiter.len(), 1, "an exhausted bucket must survive cleanup");
        clock.advance(Duration::from_secs(3));
        *last_cleanup.lock().unwrap() = Instant::now() - CLEANUP_INTERVAL;
        cleanup_if_due(&limiter, &last_cleanup);
        assert_eq!(limiter.len(), 0);
        assert!(last_cleanup.lock().unwrap().elapsed() < CLEANUP_INTERVAL);
    }

    #[tokio::test]
    async fn cold_boot_assets_do_not_exhaust_the_unmatched_allowance_but_missing_versions_do() {
        let state = RateLimitState::new(1, 1);
        let app = test_router(state.clone());
        let asset = crate::app_router::embedded_immutable_sample_path()
            .expect("frontend build must contain an immutable JS asset");
        for index in 0..40 {
            assert_eq!(
                request(&app, &format!("{asset}?load={index}"), "192.0.2.1:1234").await,
                StatusCode::OK
            );
        }
        assert_eq!(state.limiter.len(), 0);
        assert_eq!(
            request(
                &app,
                "/_app/immutable/chunks/absent-one.js",
                "192.0.2.1:1234"
            )
            .await,
            StatusCode::OK
        );
        assert_eq!(
            request(
                &app,
                "/_app/immutable/chunks/absent-two.js",
                "192.0.2.1:1234"
            )
            .await,
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[test]
    fn direct_or_untrusted_peers_cannot_supply_a_forwarded_identity() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "198.51.100.20".parse().unwrap());
        headers.insert(FORWARDED, "for=198.51.100.21".parse().unwrap());
        let peer = "192.0.2.1:1234".parse().unwrap();
        let mut state = RateLimitState::new(1, 1);
        assert_eq!(state.trusted_proxies.client_ip(&headers, peer), peer.ip());
        state.trusted_proxies =
            TrustedProxyConfig::from_trusted_proxies(vec!["10.0.0.0/8".parse().unwrap()]);
        assert_eq!(state.trusted_proxies.client_ip(&headers, peer), peer.ip());
    }

    #[test]
    fn trusted_peer_uses_rightmost_untrusted_address_and_canonicalizes_ipv6() {
        let mut state = RateLimitState::new(1, 1);
        state.trusted_proxies =
            TrustedProxyConfig::from_trusted_proxies(vec!["10.0.0.0/8".parse().unwrap()]);
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            "198.51.100.20, 2001:0db8:0:0:0:0:0:1, 10.1.0.1"
                .parse()
                .unwrap(),
        );
        assert_eq!(
            state
                .trusted_proxies
                .client_ip(&headers, "10.2.0.1:1234".parse().unwrap())
                .to_string(),
            "2001:db8::1"
        );
    }

    #[test]
    fn trusted_proxy_appended_fields_win_over_spoofed_leftmost_fields() {
        let policy = TrustedProxyConfig::from_trusted_proxies(vec!["10.0.0.0/8".parse().unwrap()]);
        let peer = "10.0.0.2:1234".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "198.51.100.99".parse().unwrap());
        headers.append(
            "x-forwarded-for",
            "198.51.100.20, 10.0.0.1".parse().unwrap(),
        );
        assert_eq!(
            policy.client_ip(&headers, peer).to_string(),
            "198.51.100.20"
        );

        headers.clear();
        headers.insert(FORWARDED, "for=198.51.100.99;proto=https".parse().unwrap());
        headers.append(
            FORWARDED,
            "For=\"[2001:db8::1]:4711\";proto=https, for=10.0.0.1"
                .parse()
                .unwrap(),
        );
        assert_eq!(policy.client_ip(&headers, peer).to_string(), "2001:db8::1");
        headers.clear();
        headers.insert(
            FORWARDED,
            "for=198.51.100.99;proto=https, for=198.51.100.20;proto=https"
                .parse()
                .unwrap(),
        );
        assert_eq!(
            policy.client_ip(&headers, peer).to_string(),
            "198.51.100.20"
        );
    }

    #[test]
    fn malformed_or_all_trusted_xff_cannot_fall_back_to_spoofed_forwarded() {
        let policy = TrustedProxyConfig::from_trusted_proxies(vec!["10.0.0.0/8".parse().unwrap()]);
        let peer: SocketAddr = "10.0.0.2:1234".parse().unwrap();
        for xff in ["198.51.100.99, malformed", "10.0.0.1", "", "unknown"] {
            let mut headers = HeaderMap::new();
            headers.insert("x-forwarded-for", xff.parse().unwrap());
            headers.insert(FORWARDED, "for=198.51.100.99".parse().unwrap());
            assert_eq!(policy.client_ip(&headers, peer), peer.ip(), "{xff}");
        }
    }

    #[test]
    fn forwarded_preserves_address_forms_and_rejects_ambiguous_rightmost_elements() {
        let policy = TrustedProxyConfig::from_trusted_proxies(vec!["10.0.0.0/8".parse().unwrap()]);
        let peer: SocketAddr = "10.0.0.2:1234".parse().unwrap();
        for (forwarded, expected) in [
            ("for=198.51.100.20", "198.51.100.20"),
            ("for=\"198.51.100.20:4711\"", "198.51.100.20"),
            ("for=\"[2001:db8::1]\"", "2001:db8::1"),
            ("for=\"[2001:db8::1]:4711\"", "2001:db8::1"),
            ("for=198.51.100.99, for=unknown", "10.0.0.2"),
            ("for=198.51.100.99, for=_hidden", "10.0.0.2"),
            ("for=198.51.100.99, for=\"malformed", "10.0.0.2"),
            ("for=198.51.100.99, by=10.0.0.1", "10.0.0.2"),
            ("for=198.51.100.99;for=198.51.100.20", "10.0.0.2"),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(FORWARDED, forwarded.parse().unwrap());
            assert_eq!(
                policy.client_ip(&headers, peer).to_string(),
                expected,
                "{forwarded}"
            );
        }
    }

    #[tokio::test]
    async fn spoofed_forwarding_headers_cannot_refresh_a_direct_clients_burst() {
        let app = test_router(RateLimitState::new(1, 1));
        for (spoof, expected) in [
            ("198.51.100.1", StatusCode::OK),
            ("198.51.100.2", StatusCode::TOO_MANY_REQUESTS),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::get("/api/users/one")
                        .header("x-forwarded-for", spoof)
                        .extension(ConnectInfo("192.0.2.1:1234".parse::<SocketAddr>().unwrap()))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
    }
}
