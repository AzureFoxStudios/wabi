//! mDNS service discovery for Wabi helpers (Phase 5B, 5C).
//!
//! Helpers advertise themselves via mDNS so LAN clients can discover them
//! without hitting the authority.  The authority *can* also browse mDNS to
//! augment its registry, but the canonical source of truth is still the
//! heartbeat-based registration in `nodes/mod.rs`.
//!
//! Service type: `_wabi._tcp.local.`
//! TXT properties:
//!   - `node_id` — the helper's node id
//!   - `version` — protocol version, currently "1"
//!   - `capability` — comma-separated capabilities (e.g. "media_relay,thumbnail_worker")

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use std::collections::HashMap;
use std::net::SocketAddr;
use tracing::{error, info, warn};

const SERVICE_TYPE: &str = "_wabi._tcp.local.";
const PROTO_VERSION: &str = "1";

/// Register this helper on mDNS so LAN clients can find it.
///
/// `bind_addr` is the address we actually listen on (e.g. 192.168.1.42:9999).
/// `node_id` and `capabilities` are stored in TXT records.
///
/// Returns the [`ServiceDaemon`] handle.  Keep it alive for the duration of
/// the helper process; dropping it will unregister the service.
pub fn register_wabi_helper(
    bind_addr: SocketAddr,
    node_id: &str,
    capabilities: &[crate::nodes::NodeCapability],
) -> Result<ServiceDaemon, mdns_sd::Error> {
    let daemon = ServiceDaemon::new()?;

    let port = bind_addr.port();

    // Build hostname from bind_addr.  If it's an IP, use a mDNS-friendly name.
    let hostname = format!("wabi-helper-{node_id}.local.");

    let props: [(&str, &str); 3] = [
        ("node_id", node_id),
        ("version", PROTO_VERSION),
        (
            "capabilities",
            &capabilities
                .iter()
                .map(|c| c.to_string())
                .collect::<Vec<_>>()
                .join(","),
        ),
    ];

    let service_info = ServiceInfo::new(
        SERVICE_TYPE,
        &format!("wabi-{node_id}"),
        &hostname,
        "", // auto-detect IPs
        port,
        &props[..],
    )?
    .enable_addr_auto();

    daemon.register(service_info)?;

    info!(
        "[mdns] Registered {} on port {} with capabilities {:?}",
        SERVICE_TYPE, port, capabilities
    );

    Ok(daemon)
}

/// Browse for `_wabi._tcp` services on the local network.
///
/// Returns a map `node_id → SocketAddr`.  Callers can use this to discover
/// helpers without querying the authority.
///
/// The `timeout_ms` parameter controls how long we wait for first results.
/// A value of `2000` is usually enough for a LAN with a couple of devices.
///
/// # Example
///
/// ```ignore
/// let helpers = mdns::browse_wabi_helpers(2000).await?;
/// for (node_id, addr) in helpers {
///     println!("Found helper {} at {}", node_id, addr);
/// }
/// ```
pub async fn browse_wabi_helpers(
    timeout_ms: u64,
) -> Result<HashMap<String, SocketAddr>, mdns_sd::Error> {
    let daemon = ServiceDaemon::new()?;
    let receiver = daemon.browse(SERVICE_TYPE)?;

    let mut found = HashMap::new();
    let start = std::time::Instant::now();

    while start.elapsed().as_millis() < timeout_ms as u128 {
        // recv_async will block for a short while — give each iteration a tight cap.
        match tokio::time::timeout(std::time::Duration::from_millis(200), receiver.recv_async())
            .await
        {
            Ok(Ok(ServiceEvent::ServiceResolved(info))) => {
                let node_id = info
                    .get_property_val_str("node_id")
                    .map(|s| s.to_string())
                    .or_else(|| {
                        // Fall back to parsing from instance name: "wabi-{node_id}.{_wabi._tcp.local.}"
                        let full = info.get_fullname();
                        full.split('.')
                            .next()
                            .map(|s| s.trim_start_matches("wabi-").to_string())
                    });

                let addrs = info.get_addresses();
                let port = info.get_port();

                if let Some(ref id) = node_id {
                    // Prefer any non-loopback address advertised in the record.
                    if let Some(ip) = addrs.iter().find(|a| !a.to_ip_addr().is_loopback()) {
                        found.insert(id.clone(), SocketAddr::new(ip.to_ip_addr(), port));
                    }
                }
            }
            Ok(Ok(_)) => { /* other events — ignore for this sweep */ }
            Ok(Err(_)) => {
                error!("[mdns] Browse channel closed unexpectedly");
                break;
            }
            Err(_) => { /* timeout — no event in this slice, keep looping */ }
        }
    }

    let _ = daemon.shutdown();
    info!("[mdns] Browse completed: {} helpers found", found.len());
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn browse_with_no_local_helpers_returns_empty() {
        // If nobody is advertising on this LAN, the sweep should return {}.
        let result = browse_wabi_helpers(500).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }
}
