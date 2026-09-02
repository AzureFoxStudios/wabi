//! Tailcat private-access client commands.
//!
//! Desktop-side half of the private-access feature
//! (docs/plans/2026-09-01-tailcat-private-access.md):
//! - `tailcat_register_key` generates a per-device client keypair and
//!   returns the public key; the frontend registers it against the member's
//!   Wabi account via POST /api/addons/tailcat/keys.
//! - `tailcat_connect` dials the server's tc… address through `tailcat
//!   socks` AND starts a local HTTP forwarder (tailcat_proxy) so the webview
//!   — which cannot speak SOCKS — can route all app traffic through the
//!   tunnel by pointing the server URL at `http://127.0.0.1:<proxyPort>`.
//! - `tailcat_disconnect` / `tailcat_status` manage the tunnel lifetime.
//!
//! Binary resolution order: `WABI_TAILCAT_BINARY` env → bundled sidecar in
//! the resource dir (`binaries/tailcat`, see scripts/fetch-tailcat-sidecar.sh
//! and tauri.conf.json `externalBin`) → `tailcat` on PATH.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;

const BINARY_ENV: &str = "WABI_TAILCAT_BINARY";

/// Resolve the tailcat binary: env override → bundled sidecar → PATH.
fn resolve_binary(app: &tauri::AppHandle) -> String {
    if let Ok(from_env) = std::env::var(BINARY_ENV) {
        let trimmed = from_env.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    use tauri::Manager;
    if let Ok(resource) = app
        .path()
        .resolve("binaries/tailcat", tauri::path::BaseDirectory::Resource)
    {
        if resource.is_file() {
            return resource.to_string_lossy().into_owned();
        }
    }
    "tailcat".to_string()
}

pub struct TailcatState {
    child: Mutex<Option<Child>>,
    socks_port: Mutex<Option<u16>>,
    proxy_port: Mutex<Option<u16>>,
    shutdown: Mutex<Option<tokio::sync::watch::Sender<bool>>>,
}

impl Default for TailcatState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            socks_port: Mutex::new(None),
            proxy_port: Mutex::new(None),
            shutdown: Mutex::new(None),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailcatTunnelStatus {
    pub connected: bool,
    pub socks_port: Option<u16>,
    pub proxy_port: Option<u16>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailcatConnectResult {
    pub socks_port: u16,
    /// The port whose `http://127.0.0.1:<proxyPort>` the app should use as
    /// its server URL while the tunnel is up.
    pub proxy_port: u16,
}

/// Generate (once) this device's tailcat client key and return its public
/// key — the value the member registers with their Wabi account.
#[tauri::command]
pub fn tailcat_register_key(app: tauri::AppHandle) -> Result<String, String> {
    let bin = resolve_binary(&app);
    // Generate idempotently: genkey keeps an existing key rather than
    // rotating; printpub then prints the client-default public key.
    let gen = Command::new(&bin)
        .args(["genkey", "--client", "--key=client-default"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("tailcat binary not available ({bin}): {e}"))?;
    if !gen.status.success() {
        return Err("tailcat genkey failed".into());
    }
    let pubout = Command::new(&bin)
        .args(["printpub"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("tailcat printpub failed: {e}"))?;
    if !pubout.status.success() {
        return Err("tailcat printpub failed".into());
    }
    Ok(String::from_utf8_lossy(&pubout.stdout).trim().to_string())
}

/// Pick a free local TCP port by binding to :0.
fn free_port() -> Result<u16, String> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .map(|l| l.local_addr().map(|a| a.port()).unwrap_or(0))
        .map_err(|e| format!("no free local port: {e}"))
}

/// Dial the server's tailcat address (SOCKS tunnel) and start the local
/// HTTP forwarder. Returns both ports; the app points its server URL at
/// `http://127.0.0.1:<proxy_port>`.
#[tauri::command]
pub async fn tailcat_connect(
    address: String,
    pipe_port: u16,
    app: tauri::AppHandle,
    state: tauri::State<'_, TailcatState>,
) -> Result<TailcatConnectResult, String> {
    let addr = address.trim().to_string();
    if !addr.starts_with("tc") {
        return Err("not a tailcat address (must start with 'tc')".into());
    }
    // Replace any existing tunnel: one connection profile at a time.
    let _ = tailcat_disconnect(state.clone()).await;

    let socks_port = free_port()?;
    let proxy_port = free_port()?;
    let bin = resolve_binary(&app);
    let mut child = Command::new(&bin)
        .args([
            "socks",
            format!("--listen=127.0.0.1:{socks_port}").as_str(),
            addr.as_str(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start tailcat socks ({bin}): {e}"))?;

    // Give the tunnel a moment to come up before the forwarder starts
    // serving (otherwise first requests race the tunnel bootstrap).
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    if let Ok(Some(_)) = child.try_wait() {
        return Err("tailcat socks exited immediately (bad address or no network)".into());
    }

    let (tx, rx) = tokio::sync::watch::channel(false);
    let target = format!("server.tailcat:{pipe_port}");
    tokio::spawn(async move {
        if let Err(e) = crate::tailcat_proxy::run(
            std::net::SocketAddr::from(([127, 0, 0, 1], proxy_port)),
            target,
            socks_port,
            rx,
        )
        .await
        {
            log::warn!("[tailcat] local forwarder stopped: {e}");
        }
    });

    *state.child.lock().map_err(|e| e.to_string())? = Some(child);
    *state.socks_port.lock().map_err(|e| e.to_string())? = Some(socks_port);
    *state.proxy_port.lock().map_err(|e| e.to_string())? = Some(proxy_port);
    *state.shutdown.lock().map_err(|e| e.to_string())? = Some(tx);
    Ok(TailcatConnectResult {
        socks_port,
        proxy_port,
    })
}

/// Kill the tunnel and the local forwarder (instant).
#[tauri::command]
pub async fn tailcat_disconnect(
    state: tauri::State<'_, TailcatState>,
) -> Result<(), String> {
    if let Some(tx) = state.shutdown.lock().map_err(|e| e.to_string())?.take() {
        let _ = tx.send(true);
    }
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    *state.socks_port.lock().map_err(|e| e.to_string())? = None;
    *state.proxy_port.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[tauri::command]
pub fn tailcat_status(state: tauri::State<TailcatState>) -> TailcatTunnelStatus {
    let mut connected = false;
    if let Ok(mut guard) = state.child.lock() {
        match guard.as_mut() {
            Some(child) => {
                // try_wait needs &mut; a dead child clears the tunnel state.
                match child.try_wait() {
                    Ok(Some(_)) => {
                        *guard = None;
                        if let Ok(mut p) = state.socks_port.lock() {
                            *p = None;
                        }
                        if let Ok(mut p) = state.proxy_port.lock() {
                            *p = None;
                        }
                    }
                    Ok(None) => connected = true,
                    Err(_) => {}
                }
            }
            None => {}
        }
    }
    TailcatTunnelStatus {
        connected,
        socks_port: state.socks_port.lock().ok().and_then(|p| *p),
        proxy_port: state.proxy_port.lock().ok().and_then(|p| *p),
    }
}
