//! Admin-only observations. Interface counters belong to the network namespace,
//! not exclusively to Wabi. Never sum physical and overlay interfaces.
use crate::state::AppState;
use axum::{
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};

#[derive(Default)]
pub struct Sampler(Mutex<Option<Sample>>);
struct Sample {
    at: Instant,
    ticks: Option<u64>,
    interfaces: BTreeMap<String, (u64, u64)>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSnapshot {
    observed_at: String,
    sample_seconds: Option<f64>,
    process_memory_bytes: Option<u64>,
    process_cpu_percent: Option<f64>,
    interfaces: Vec<Interface>,
    http_requests_total: u64,
    uptime_seconds: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Interface {
    name: String,
    received_bytes: u64,
    sent_bytes: u64,
    received_bytes_per_second: Option<f64>,
    sent_bytes_per_second: Option<f64>,
}

fn cpu_ticks(stat: &str) -> Option<u64> {
    // comm can contain spaces and parentheses; fields after its final ')' start at field 3.
    let fields: Vec<_> = stat.rsplit_once(')')?.1.split_whitespace().collect();
    fields
        .get(11)?
        .parse::<u64>()
        .ok()?
        .checked_add(fields.get(12)?.parse::<u64>().ok()?)
}
fn interfaces(raw: &str) -> BTreeMap<String, (u64, u64)> {
    raw.lines()
        .filter_map(|line| {
            let (name, data) = line.split_once(':')?;
            let fields: Vec<_> = data.split_whitespace().collect();
            Some((
                name.trim().to_string(),
                (fields.first()?.parse().ok()?, fields.get(8)?.parse().ok()?),
            ))
        })
        .collect()
}
pub(super) fn tick_rate() -> Option<f64> {
    static RATE: OnceLock<Option<f64>> = OnceLock::new();
    *RATE.get_or_init(|| {
        if !cfg!(target_os = "linux") {
            return None;
        }
        let result = std::process::Command::new("getconf")
            .arg("CLK_TCK")
            .output()
            .ok()?;
        if !result.status.success() {
            return None;
        }
        String::from_utf8(result.stdout)
            .ok()?
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite() && *n > 0.0)
    })
}
fn rate(now: u64, before: u64, seconds: f64) -> Option<f64> {
    (seconds >= 1.0)
        .then(|| now.checked_sub(before).map(|n| n as f64 / seconds))
        .flatten()
}
impl Sampler {
    fn snapshot(&self, state: &AppState) -> NetworkSnapshot {
        let ticks = std::fs::read_to_string("/proc/self/stat")
            .ok()
            .and_then(|s| cpu_ticks(&s));
        let current = Sample {
            at: Instant::now(),
            ticks,
            interfaces: std::fs::read_to_string("/proc/net/dev")
                .map(|s| interfaces(&s))
                .unwrap_or_default(),
        };
        let memory = std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|raw| {
                raw.lines().find_map(|line| {
                    line.strip_prefix("VmRSS:").and_then(|s| {
                        s.split_whitespace()
                            .next()?
                            .parse::<u64>()
                            .ok()?
                            .checked_mul(1024)
                    })
                })
            });
        let mut previous = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let seconds = previous
            .as_ref()
            .map(|p| current.at.duration_since(p.at).as_secs_f64());
        let cpu = previous.as_ref().and_then(|p| {
            rate(ticks?, p.ticks?, seconds?).and_then(|n| Some(n * 100.0 / tick_rate()?))
        });
        let rows = current
            .interfaces
            .iter()
            .map(|(name, (rx, tx))| {
                let before = previous.as_ref().and_then(|p| p.interfaces.get(name));
                Interface {
                    name: name.clone(),
                    received_bytes: *rx,
                    sent_bytes: *tx,
                    received_bytes_per_second: before.and_then(|b| rate(*rx, b.0, seconds?)),
                    sent_bytes_per_second: before.and_then(|b| rate(*tx, b.1, seconds?)),
                }
            })
            .collect();
        // Frequent readers cannot starve the minimum sampling interval.
        if seconds.is_none_or(|s| s >= 1.0) {
            *previous = Some(current);
        }
        let http = crate::metrics::MetricsState::snapshot();
        NetworkSnapshot {
            observed_at: chrono::Utc::now().to_rfc3339(),
            sample_seconds: seconds,
            process_memory_bytes: memory,
            process_cpu_percent: cpu,
            interfaces: rows,
            http_requests_total: http.requests_total,
            uptime_seconds: state.started_at.elapsed().as_secs(),
        }
    }
}
pub async fn get(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(response) = super::admin::admin_auth(&headers, &state).await {
        return response;
    }
    Json(state.network_health.snapshot(&state)).into_response()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_process_name_and_networks_without_combining_interfaces() {
        let stat = "12 (worker ) name) S 1 2 3 4 5 6 7 8 9 10 20 30";
        assert_eq!(cpu_ticks(stat), Some(50));
        let rows =
            interfaces("eth0: 100 0 0 0 0 0 0 0 200\ntailscale0: 50 0 0 0 0 0 0 0 80\ninvalid");
        assert_eq!(rows["eth0"], (100, 200));
        assert_eq!(rows.len(), 2);
        assert_eq!(rate(200, 100, 2.0), Some(50.0));
        assert_eq!(rate(10, 100, 2.0), None);
        assert_eq!(rate(200, 100, 0.1), None);
    }
}
