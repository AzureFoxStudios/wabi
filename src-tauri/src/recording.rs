use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use tauri::{AppHandle, Manager};

/// Sanitize a caller-supplied file name so it can never escape the recordings
/// directory (path traversal / control characters are neutralized).
fn sanitize_recording_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "recording.webm".to_string()
    } else {
        cleaned
    }
}

/// Save a call recording (base64 payload) to Documents/WabiRecordings so the
/// desktop build can persist mixed + stem recordings to disk instead of falling
/// back to a browser download. Matches the `save_call_recording` invoke in
/// `frontend/src/lib/tauri-recording.ts`.
#[tauri::command]
pub fn save_call_recording(
    app: AppHandle,
    suggested_name: String,
    bytes_base64: String,
) -> Result<String, String> {
    let bytes = BASE64_STANDARD
        .decode(bytes_base64.trim())
        .map_err(|e| format!("Invalid recording payload: {e}"))?;

    let base_dir = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| format!("Could not resolve a recordings directory: {e}"))?;

    let recordings_dir = base_dir.join("WabiRecordings");
    std::fs::create_dir_all(&recordings_dir)
        .map_err(|e| format!("Could not create recordings directory: {e}"))?;

    let file_name = sanitize_recording_file_name(&suggested_name);
    let dest = recordings_dir.join(&file_name);
    std::fs::write(&dest, &bytes).map_err(|e| format!("Failed to save recording: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}
