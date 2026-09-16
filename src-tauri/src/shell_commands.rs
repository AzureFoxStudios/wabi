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
        for url in ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hello", "mailto:x@example.com", "not a url"] {
            assert!(allowed_external_url(url).is_err(), "unexpected allowed URL: {url}");
        }
    }
}
