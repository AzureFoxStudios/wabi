use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// Hand-rolled Prometheus metrics — zero new deps (supply-chain policy).
/// Global state via static — the middleware and the handler both read this.
static STATE: OnceLock<MetricsState> = OnceLock::new();

fn get() -> &'static MetricsState {
    STATE.get_or_init(MetricsState::new)
}

/// Cumulative histogram buckets in milliseconds (Prometheus `le` upper bounds).
/// Chosen to cover interactive-API territory up to the 30s TimeoutLayer cap:
/// 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s, 10s, 30s, +Inf.
pub const LATENCY_BUCKETS_MS: [u64; 13] = [
    5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, u64::MAX,
];

#[derive(Debug)]
pub struct MetricsState {
    pub requests_total: AtomicU64,
    pub ws_connected: AtomicU64,
    /// Per-bucket cumulative request counts. Index i counts requests whose
    /// duration was <= LATENCY_BUCKETS_MS[i]. Last bucket is +Inf.
    pub latency_buckets: Vec<AtomicU64>,
    /// Sum of all request durations in ms (for a mean alongside the buckets).
    pub latency_sum_ms: AtomicU64,
}

impl Clone for MetricsState {
    fn clone(&self) -> Self {
        // Clone returns a fresh snapshot — used for router state wiring.
        // Live updates go through the global via `get()`.
        Self {
            requests_total: AtomicU64::new(self.requests_total.load(Ordering::Relaxed)),
            ws_connected: AtomicU64::new(self.ws_connected.load(Ordering::Relaxed)),
            latency_buckets: self
                .latency_buckets
                .iter()
                .map(|b| AtomicU64::new(b.load(Ordering::Relaxed)))
                .collect(),
            latency_sum_ms: AtomicU64::new(self.latency_sum_ms.load(Ordering::Relaxed)),
        }
    }
}

impl Default for MetricsState {
    fn default() -> Self {
        Self {
            requests_total: AtomicU64::new(0),
            ws_connected: AtomicU64::new(0),
            latency_buckets: (0..LATENCY_BUCKETS_MS.len())
                .map(|_| AtomicU64::new(0))
                .collect(),
            latency_sum_ms: AtomicU64::new(0),
        }
    }
}

impl MetricsState {
    pub fn new() -> Self {
        Self::default()
    }
    /// Record a request. Cheap atomic increment.
    pub fn record_request() {
        get().requests_total.fetch_add(1, Ordering::Relaxed);
    }
    /// Record a completed request's latency (ms) into cumulative buckets.
    /// Called from the metrics middleware after the response resolves.
    pub fn record_latency_ms(duration_ms: u64) {
        let s = get();
        s.latency_sum_ms.fetch_add(duration_ms, Ordering::Relaxed);
        for (i, bound) in LATENCY_BUCKETS_MS.iter().enumerate() {
            if duration_ms <= *bound {
                if let Some(bucket) = s.latency_buckets.get(i) {
                    bucket.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    }
    /// Snapshot for rendering.
    pub fn snapshot() -> MetricsSnapshot {
        let s = get();
        let start = START.get_or_init(Instant::now);
        MetricsSnapshot {
            requests_total: s.requests_total.load(Ordering::Relaxed),
            ws_connected: s.ws_connected.load(Ordering::Relaxed),
            uptime_seconds: start.elapsed().as_secs(),
            latency_buckets: s
                .latency_buckets
                .iter()
                .map(|b| b.load(Ordering::Relaxed))
                .collect(),
            latency_sum_ms: s.latency_sum_ms.load(Ordering::Relaxed),
        }
    }
}

#[derive(Debug, Default)]
pub struct MetricsSnapshot {
    pub requests_total: u64,
    pub ws_connected: u64,
    pub uptime_seconds: u64,
    pub latency_buckets: Vec<u64>,
    pub latency_sum_ms: u64,
}

static START: OnceLock<Instant> = OnceLock::new();

/// Render Prometheus text exposition.
pub fn render_prometheus() -> String {
    let s = MetricsState::snapshot();
    let mut out = String::new();
    out.push_str("# HELP wabi_http_requests_total Total HTTP requests processed.\n");
    out.push_str("# TYPE wabi_http_requests_total counter\n");
    out.push_str(&format!(
        "wabi_http_requests_total{{service=\"wabi-server\"}} {}\n",
        s.requests_total
    ));
    // Latency histogram: cumulative per-bucket counters + inf + sum.
    out.push_str("# HELP wabi_http_request_duration_seconds HTTP request latency.\n");
    out.push_str("# TYPE wabi_http_request_duration_seconds histogram\n");
    let mut prev: u64 = 0;
    for (i, bound_ms) in LATENCY_BUCKETS_MS.iter().enumerate() {
        let count = s.latency_buckets.get(i).copied().unwrap_or(0);
        // Buckets are cumulative already; each le line reports its own counter.
        let _ = prev;
        prev = count;
        let le_label = if *bound_ms == u64::MAX {
            "+Inf".to_string()
        } else {
            format!("{}", *bound_ms as f64 / 1000.0)
        };
        out.push_str(&format!(
            "wabi_http_request_duration_seconds_bucket{{service=\"wabi-server\",le=\"{le_label}\"}} {count}\n"
        ));
    }
    out.push_str(&format!(
        "wabi_http_request_duration_seconds_sum{{service=\"wabi-server\"}} {:.6}\n",
        s.latency_sum_ms as f64 / 1000.0
    ));
    let total_observable = s.latency_buckets.last().copied().unwrap_or(0);
    out.push_str(&format!(
        "wabi_http_request_duration_seconds_count{{service=\"wabi-server\"}} {total_observable}\n"
    ));
    out.push_str("# HELP wabi_ws_sockets_connected Currently connected websocket sockets.\n");
    out.push_str("# TYPE wabi_ws_sockets_connected gauge\n");
    out.push_str(&format!(
        "wabi_ws_sockets_connected{{service=\"wabi-server\"}} {}\n",
        s.ws_connected
    ));
    out.push_str("# HELP wabi_uptime_seconds Server uptime in seconds.\n");
    out.push_str("# TYPE wabi_uptime_seconds gauge\n");
    out.push_str(&format!(
        "wabi_uptime_seconds{{service=\"wabi-server\"}} {}\n",
        s.uptime_seconds
    ));
    out
}
