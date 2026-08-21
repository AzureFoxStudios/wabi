use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

/// Hand-rolled Prometheus metrics — zero new deps (supply-chain policy).
/// Global state via static — the middleware and the handler both read this.
static STATE: OnceLock<MetricsState> = OnceLock::new();

fn get() -> &'static MetricsState {
    STATE.get_or_init(MetricsState::new)
}

#[derive(Debug)]
pub struct MetricsState {
    pub requests_total: AtomicU64,
    pub ws_connected: AtomicU64,
}

impl Clone for MetricsState {
    fn clone(&self) -> Self {
        // Clone returns a fresh snapshot — used for router state wiring.
        // Live updates go through the global via `get()`.
        Self {
            requests_total: AtomicU64::new(self.requests_total.load(Ordering::Relaxed)),
            ws_connected: AtomicU64::new(self.ws_connected.load(Ordering::Relaxed)),
        }
    }
}

impl Default for MetricsState {
    fn default() -> Self {
        Self {
            requests_total: AtomicU64::new(0),
            ws_connected: AtomicU64::new(0),
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
    /// Snapshot for rendering.
    pub fn snapshot() -> MetricsSnapshot {
        let s = get();
        let start = START.get_or_init(Instant::now);
        MetricsSnapshot {
            requests_total: s.requests_total.load(Ordering::Relaxed),
            ws_connected: s.ws_connected.load(Ordering::Relaxed),
            uptime_seconds: start.elapsed().as_secs(),
        }
    }
}

#[derive(Debug, Default)]
pub struct MetricsSnapshot {
    pub requests_total: u64,
    pub ws_connected: u64,
    pub uptime_seconds: u64,
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
