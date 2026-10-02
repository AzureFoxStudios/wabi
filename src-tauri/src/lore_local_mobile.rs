//! Mobile boundary for desktop-only Lore local workspace operations.
//!
//! Android and iOS do not expose Wabi's desktop arbitrary-folder staging model.
//! Keep the command names registered so shared frontend code receives a clear,
//! deterministic error instead of a missing-command failure or a broader mobile
//! filesystem grant.

use serde_json::Value;
use tauri::{State, WebviewWindow};

const MOBILE_UNAVAILABLE: &str =
    "Local Lore workspace folders are desktop-only. Use the in-app Lore workspace on mobile.";

#[derive(Default)]
pub struct LocalWorkspaceState;

fn unavailable<T>() -> Result<T, String> {
    Err(MOBILE_UNAVAILABLE.into())
}

#[tauri::command]
pub async fn lore_local_choose(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, LocalWorkspaceState>,
    server_url: String,
    channel_id: i64,
    account_id: String,
) -> Result<Option<Value>, String> {
    let _ = (app, window, state, server_url, channel_id, account_id);
    unavailable()
}

#[tauri::command]
pub async fn lore_local_scan(
    window: WebviewWindow,
    state: State<'_, LocalWorkspaceState>,
    handle: String,
) -> Result<Value, String> {
    let _ = (window, state, handle);
    unavailable()
}

#[tauri::command]
pub async fn lore_local_save_state(
    window: WebviewWindow,
    state: State<'_, LocalWorkspaceState>,
    handle: String,
    index: Value,
) -> Result<(), String> {
    let _ = (window, state, handle, index);
    unavailable()
}

#[tauri::command]
pub fn lore_local_open(
    window: WebviewWindow,
    state: State<'_, LocalWorkspaceState>,
    handle: String,
) -> Result<(), String> {
    let _ = (window, state, handle);
    unavailable()
}

#[tauri::command]
pub async fn lore_local_publish(
    window: WebviewWindow,
    state: State<'_, LocalWorkspaceState>,
    handle: String,
    path: String,
    local_hash: Option<String>,
    remote_etag: Option<String>,
    token: String,
    message: String,
) -> Result<Value, String> {
    let _ = (window, state, handle, path, local_hash, remote_etag, token, message);
    unavailable()
}

#[tauri::command]
pub async fn lore_local_pull(
    window: WebviewWindow,
    state: State<'_, LocalWorkspaceState>,
    handle: String,
    path: String,
    local_hash: Option<String>,
    remote_etag: Option<String>,
    token: String,
) -> Result<Value, String> {
    let _ = (window, state, handle, path, local_hash, remote_etag, token);
    unavailable()
}

pub mod detection {
    use super::{unavailable, LocalWorkspaceState};
    use serde_json::Value;
    use tauri::{State, WebviewWindow};

    #[derive(Default)]
    pub struct LocalDetectionState;

    #[tauri::command]
    pub async fn lore_local_watch_poll(
        window: WebviewWindow,
        state: State<'_, LocalWorkspaceState>,
        detection: State<'_, LocalDetectionState>,
        handle: String,
        subscription: Option<String>,
    ) -> Result<Value, String> {
        let _ = (window, state, detection, handle, subscription);
        unavailable()
    }

    #[tauri::command]
    pub fn lore_local_watch_stop(
        window: WebviewWindow,
        state: State<'_, LocalWorkspaceState>,
        detection: State<'_, LocalDetectionState>,
        handle: String,
        subscription: String,
    ) -> Result<(), String> {
        let _ = (window, state, detection, handle, subscription);
        unavailable()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mobile_boundary_is_explicit() {
        assert_eq!(unavailable::<()>().unwrap_err(), MOBILE_UNAVAILABLE);
    }
}
