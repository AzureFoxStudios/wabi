use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MediaRuntimeCapabilities {
    pub supports_native_audio_pipeline: bool,
    pub supports_srt_gateway: bool,
    pub supports_hardware_acceleration_hinting: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MediaTransportPreferences {
    pub quality_mode: String,
    pub srt_gateway_enabled: bool,
    pub preferred_audio_bitrate: u32,
    pub preferred_video_bitrate: u32,
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;

    fs::create_dir_all(&dir).map_err(|e| format!("failed to create app data dir: {e}"))?;
    Ok(dir)
}

fn read_json_file(path: &PathBuf) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }

    let content = fs::read_to_string(path).map_err(|e| format!("failed reading file: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("failed parsing json: {e}"))
}

fn write_json_file(path: &PathBuf, value: &Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value).map_err(|e| format!("failed serializing json: {e}"))?;
    fs::write(path, content).map_err(|e| format!("failed writing file: {e}"))
}

#[tauri::command]
pub fn save_burndown_chart(app: AppHandle, chart_id: String, payload: Value) -> Result<String, String> {
    let path = app_data_dir(&app)?.join("burndown_charts.json");
    let mut data = read_json_file(&path)?;

    if !data.is_object() {
        data = json!({});
    }

    data[chart_id] = payload;
    write_json_file(&path, &data)?;
    Ok("burndown chart saved".to_string())
}

#[tauri::command]
pub fn load_burndown_chart(app: AppHandle, chart_id: String) -> Result<Option<Value>, String> {
    let path = app_data_dir(&app)?.join("burndown_charts.json");
    let data = read_json_file(&path)?;
    Ok(data.get(&chart_id).cloned())
}

#[tauri::command]
pub fn save_reminders(app: AppHandle, reminders: Value) -> Result<String, String> {
    let path = app_data_dir(&app)?.join("reminders.json");
    write_json_file(&path, &reminders)?;
    Ok("reminders saved".to_string())
}

#[tauri::command]
pub fn load_reminders(app: AppHandle) -> Result<Value, String> {
    let path = app_data_dir(&app)?.join("reminders.json");
    read_json_file(&path)
}

#[tauri::command]
pub fn delete_reminders(app: AppHandle) -> Result<String, String> {
    let path = app_data_dir(&app)?.join("reminders.json");
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("failed removing reminders: {e}"))?;
    }
    Ok("reminders deleted".to_string())
}

#[tauri::command]
pub fn get_data_stats(app: AppHandle) -> Result<Value, String> {
    let dir = app_data_dir(&app)?;
    let mut total_size: u64 = 0;
    let mut file_count: u64 = 0;

    for entry in fs::read_dir(dir).map_err(|e| format!("failed reading app dir: {e}"))? {
        let entry = entry.map_err(|e| format!("failed reading entry: {e}"))?;
        let metadata = entry
            .metadata()
            .map_err(|e| format!("failed reading metadata: {e}"))?;
        if metadata.is_file() {
            file_count += 1;
            total_size += metadata.len();
        }
    }

    Ok(json!({
        "file_count": file_count,
        "total_size_bytes": total_size
    }))
}

#[tauri::command]
pub fn clear_binary_data(app: AppHandle) -> Result<String, String> {
    let dir = app_data_dir(&app)?;
    for entry in fs::read_dir(dir).map_err(|e| format!("failed reading app dir: {e}"))? {
        let entry = entry.map_err(|e| format!("failed reading entry: {e}"))?;
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "bin") {
            fs::remove_file(path).map_err(|e| format!("failed removing binary file: {e}"))?;
        }
    }
    Ok("binary data cleared".to_string())
}

#[tauri::command]
pub fn get_media_runtime_capabilities() -> MediaRuntimeCapabilities {
    MediaRuntimeCapabilities {
        supports_native_audio_pipeline: true,
        supports_srt_gateway: true,
        supports_hardware_acceleration_hinting: true,
    }
}

#[tauri::command]
pub fn set_media_transport_preferences(app: AppHandle, preferences: MediaTransportPreferences) -> Result<String, String> {
    let path = app_data_dir(&app)?.join("media_transport_preferences.json");
    let value = serde_json::to_value(preferences).map_err(|e| format!("failed serializing preferences: {e}"))?;
    write_json_file(&path, &value)?;
    Ok("media transport preferences saved".to_string())
}

#[tauri::command]
pub fn get_media_transport_preferences(app: AppHandle) -> Result<MediaTransportPreferences, String> {
    let path = app_data_dir(&app)?.join("media_transport_preferences.json");

    if !path.exists() {
        return Ok(MediaTransportPreferences {
            quality_mode: "local-enhanced".to_string(),
            srt_gateway_enabled: false,
            preferred_audio_bitrate: 96000,
            preferred_video_bitrate: 2_200_000,
        });
    }

    let value = read_json_file(&path)?;
    serde_json::from_value(value).map_err(|e| format!("failed decoding preferences: {e}"))
}

#[tauri::command]
pub fn save_layout_state(app: AppHandle, layout_json: String) -> Result<String, String> {
    let path = app_data_dir(&app)?.join("dock_layout_state.json");
    fs::write(path, layout_json).map_err(|e| format!("failed writing layout state: {e}"))?;
    Ok("layout state saved".to_string())
}

#[tauri::command]
pub fn load_layout_state(app: AppHandle) -> Result<Option<String>, String> {
    let path = app_data_dir(&app)?.join("dock_layout_state.json");
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(path).map_err(|e| format!("failed reading layout state: {e}"))?;
    Ok(Some(content))
}
