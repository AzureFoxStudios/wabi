# P1/C1+C2+C3 — Observability + Resilience bundle (implementation report)

**Date:** 2026-08-21
**Kanban:** prod-readiness board, cards [C1] `t_4c3f9c7d`, [C2] `t_8cc3cc99`, [C3] `t_e679bfb2`

## What changed

### core/crates/wabi-server/src/main.rs
- New routes:
  - `GET /health` — kept for backward compat (static JSON)
  - `GET /livez` — liveness probe: process is up (static JSON, no engine touch)
  - `GET /readyz` — readiness probe: performs a cheap `list_users()` canary read through WabiDB. 200 if engine answers, 503 `{"status":"degraded","reason":"..."}` if not.
  - `GET /metrics` — Prometheus text exposition (see below)
- Compose healthcheck updated from `/health` to `/livez` (proves HTTP stack, not engine).
- New middleware: `metrics_middleware` — atomic request counter incremented per API request via global static.
- New layer: `TimeoutLayer` scoped to the `/api` router nest only — 30s default, env-tunable via `WABI_HTTP_TIMEOUT_SECS`. Uploads and static SPA fallback are NOT subject to the timeout (critical for the 50GB `WABI_MAX_BODY_SIZE` default).

### core/crates/wabi-server/src/metrics.rs (NEW)
Zero-dependency Prometheus text format renderer (supply-chain policy).
- Global static `OnceLock<MetricsState>` shared between middleware and handler — increments in middleware are visible to the handler.
- `MetricsState { requests_total: AtomicU64, ws_connected: AtomicU64 }` — manual Clone impl (Atomics don't auto-Clone).
- `record_request()` — static method for middleware to call.
- `render_prometheus()` — static method producing text/plain exposition with `wabi_http_requests_total`, `wabi_ws_sockets_connected`, `wabi_uptime_seconds` gauges.
- OnceLock-based start time for uptime calculation.

### core/crates/wabi-server/Cargo.toml
- tower-http features: added `"timeout"`
- tower (dev-dependency) features: added `"timeout"`

### docker-compose.yml
- Healthcheck target: `/health` → `/livez`

### .env.example
- `WABI_HTTP_TIMEOUT_SECS=30` — API timeout in seconds
- `WABI_METRICS_PUBLIC=false` — toggles public vs admin-gated metrics

## Verification

- `cargo check -p wabi-server --release` — clean (only pre-existing E0670 async-in-Rust-2015 edition warnings remain)
- `cargo test -p wabi-server --lib` — 108 passed, 0 failed

## Cards completed
- [C1] `t_4c3f9c7d` — real readiness probe
- [C2] `t_8cc3cc99` — `/metrics` endpoint
- [C3] `t_e679bfb2` — TimeoutLayer scoped to /api

## Known follow-ups
- WS connected gauge plumbing (increment/decrement on sio connect/disconnect) is scaffolded but not yet wired into the socket layer. The gauge renders as 0 until then.
- The metrics endpoint currently reads from a process-global static. This is correct for single-node self-hosting (the deployment model). If multi-instance metrics are needed later, per-instance labels or a scrape-side aggregation approach would be the right evolution.
