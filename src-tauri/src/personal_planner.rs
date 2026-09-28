//! Local main-window capability to the bundled sidecar. No frontend path or URL.
use serde_json::Value;
use tauri::Manager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tauri::command]
pub async fn personal_planner_request(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Value,
) -> Result<Value, String> {
    crate::hosting::authorize(&window)?;
    if request.get("scope").and_then(Value::as_str) != Some("planner:personal-desktop:v1") {
        return Err("Invalid personal Planner scope".into());
    }
    if !matches!(
        request.get("operation").and_then(Value::as_str),
        Some("read" | "write" | "drafts")
    ) {
        return Err("Invalid personal Planner operation".into());
    }
    let bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    if bytes.len() > 24 * 1024 * 1024 {
        return Err("Planner request is too large".into());
    }
    let executable = crate::hosting::binary(&app)?;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("personal-planner");
    let operation = async move {
        let mut command = tokio::process::Command::new(executable);
        command.env_clear();
        for key in [
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "HOME",
            "USERPROFILE",
            "LANG",
            "LC_ALL",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = command
            .arg("--personal-planner")
            .arg("--data-dir")
            .arg(directory)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Cannot open personal Planner storage: {e}"))?;
        let mut input = child
            .stdin
            .take()
            .ok_or("Planner input pipe is unavailable")?;
        input.write_all(&bytes).await.map_err(|e| e.to_string())?;
        drop(input);
        let output = child
            .stdout
            .take()
            .ok_or("Planner output pipe is unavailable")?;
        let mut bytes = Vec::new();
        output
            .take(64 * 1024 * 1024 + 1024)
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| e.to_string())?;
        if bytes.len() >= 64 * 1024 * 1024 + 1024 {
            return Err("Planner response exceeds its limit".into());
        }
        if !child.wait().await.map_err(|e| e.to_string())?.success() {
            return Err("Personal Planner sidecar failed. Existing records have not been replaced. Install a matching Wabi desktop package.".into());
        }
        let response: Value =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid personal Planner response")?;
        if response.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(response.get("value").cloned().unwrap_or(Value::Null))
        } else {
            Err(response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Personal Planner operation failed")
                .into())
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(30), operation)
        .await
        .map_err(|_| {
            "Personal Planner storage timed out. Keep or export your draft and retry.".to_string()
        })?
}
