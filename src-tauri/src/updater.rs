//! Desktop self-update. Updates are signed; the public key lives in
//! `tauri.conf.json`. Nothing installs without the person asking for it,
//! because installing restarts Wabi and stops a hosted community.
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use tauri_plugin_updater::{Update, UpdaterExt};

/// Rolling pre-release that CI replaces on every push to `main`. The stable
/// endpoint is the one configured in `tauri.conf.json`.
const DEV_ENDPOINT: &str =
    "https://github.com/AzureFoxStudios/wabi/releases/download/dev/latest.json";

pub struct UpdateChannel {
    dev: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    version: String,
    current_version: String,
    notes: Option<String>,
}

fn channel_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("update-channel"))
}

pub fn setup(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    app.plugin(tauri_plugin_updater::Builder::new().build())?;
    let dev = channel_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .is_some_and(|saved| saved.trim() == "dev");
    app.manage(UpdateChannel {
        dev: AtomicBool::new(dev),
    });
    Ok(())
}

pub fn dev_channel(app: &tauri::AppHandle) -> bool {
    app.state::<UpdateChannel>().dev.load(Ordering::Relaxed)
}

pub fn set_dev_channel(app: &tauri::AppHandle, dev: bool) -> Result<(), String> {
    let path = channel_path(app).ok_or("App config folder unavailable")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, if dev { "dev" } else { "stable" }).map_err(|e| e.to_string())?;
    app.state::<UpdateChannel>()
        .dev
        .store(dev, Ordering::Relaxed);
    Ok(())
}

async fn find_update(app: &tauri::AppHandle) -> Result<Option<Update>, String> {
    let mut builder = app.updater_builder();
    if dev_channel(app) {
        let endpoint = DEV_ENDPOINT.parse().map_err(|_| "Invalid update address")?;
        builder = builder.endpoints(vec![endpoint]).map_err(|e| e.to_string())?;
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    updater
        .check()
        .await
        .map_err(|error| format!("Could not check for updates: {error}"))
}

pub async fn check(app: &tauri::AppHandle) -> Result<Option<AvailableUpdate>, String> {
    Ok(find_update(app).await?.map(|update| AvailableUpdate {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
    }))
}

/// Download first, so a failed download leaves everything running. Only then
/// stop the services this app owns: on Windows the installer replaces their
/// files, and every platform restarts afterwards.
pub async fn install(app: &tauri::AppHandle) -> Result<(), String> {
    let update = find_update(app)
        .await?
        .ok_or("Wabi is already up to date")?;
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| format!("Could not download the update: {error}"))?;
    crate::hosting::shutdown(app.clone()).await;
    if let Err(error) = crate::tailcat::tailcat_disconnect(app.state()).await {
        log::warn!("Tailcat shutdown before update failed: {error}");
    }
    update
        .install(bytes)
        .map_err(|error| format!("Could not install the update: {error}"))?;
    app.restart();
}
