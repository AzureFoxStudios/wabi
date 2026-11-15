//! Commands previously registered only by the desktop binary entrypoint.

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to Wabi!", name)
}

#[tauri::command]
pub fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

fn allowed_external_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(()),
        _ => Err(format!("scheme '{}' not allowed", parsed.scheme())),
    }
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    allowed_external_url(&url)?;
    #[cfg(not(mobile))]
    {
        open::that(url).map_err(|e| e.to_string())
    }
    #[cfg(mobile)]
    {
        // This command was desktop-only before entrypoint consolidation.
        Err("Opening an external URL through this command is desktop-only".into())
    }
}

#[cfg(test)]
mod tests {
    use super::allowed_external_url;

    #[test]
    fn external_url_keeps_the_existing_web_only_boundary() {
        assert!(allowed_external_url("https://example.com/path").is_ok());
        assert!(allowed_external_url("http://localhost:3000").is_ok());
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hello",
            "mailto:x@example.com",
            "not a url",
        ] {
            assert!(
                allowed_external_url(url).is_err(),
                "unexpected allowed URL: {url}"
            );
        }
    }
}

/// Only the trusted local main webview may invoke application menu actions.
#[tauri::command]
pub fn desktop_action(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    action: String,
) -> Result<f64, String> {
    let url = window.url().map_err(|e| e.to_string())?;
    if !crate::hosting::local_main_origin(window.label(), &url, cfg!(debug_assertions)) {
        return Err("Desktop actions require Wabi's local main window".into());
    }
    #[cfg(not(mobile))]
    {
        crate::desktop::perform_action(&app, &action)
    }
    #[cfg(mobile)]
    {
        let _ = (app, action);
        Err("Desktop actions are not available on mobile".into())
    }
}

/// Read, and optionally change, whether closing the main window quits Wabi.
#[tauri::command]
pub fn desktop_close_behavior(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    quit_on_close: Option<bool>,
) -> Result<bool, String> {
    let url = window.url().map_err(|e| e.to_string())?;
    if !crate::hosting::local_main_origin(window.label(), &url, cfg!(debug_assertions)) {
        return Err("Desktop actions require Wabi's local main window".into());
    }
    #[cfg(not(mobile))]
    {
        if let Some(quit) = quit_on_close {
            crate::desktop::set_quit_on_close(&app, quit)?;
        }
        Ok(crate::desktop::quit_on_close(&app))
    }
    #[cfg(mobile)]
    {
        let _ = (app, quit_on_close);
        Err("Desktop actions are not available on mobile".into())
    }
}

/// Self-update actions for the local main window: `check`, `install`, and
/// reading or setting the development channel (`channel`, `channel-dev`,
/// `channel-stable`). The webview gets no direct updater permission.
#[tauri::command]
pub async fn desktop_update(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    action: String,
) -> Result<serde_json::Value, String> {
    let url = window.url().map_err(|e| e.to_string())?;
    if !crate::hosting::local_main_origin(window.label(), &url, cfg!(debug_assertions)) {
        return Err("Desktop actions require Wabi's local main window".into());
    }
    #[cfg(not(mobile))]
    {
        use crate::updater;
        let value = match action.as_str() {
            "check" => serde_json::to_value(updater::check(&app).await?),
            "install" => serde_json::to_value(updater::install(&app).await?),
            "channel" => serde_json::to_value(updater::dev_channel(&app)),
            "channel-dev" | "channel-stable" => {
                updater::set_dev_channel(&app, action == "channel-dev")?;
                serde_json::to_value(updater::dev_channel(&app))
            }
            _ => return Err("Unknown update action".into()),
        };
        value.map_err(|e| e.to_string())
    }
    #[cfg(mobile)]
    {
        let _ = (app, action);
        Err("Desktop actions are not available on mobile".into())
    }
}
