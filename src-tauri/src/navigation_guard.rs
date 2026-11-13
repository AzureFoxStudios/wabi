//! Keeps every app webview on Wabi's own bundled pages.
//!
//! Tauri gives the IPC bridge to whatever page loads in a window's main frame, and Wabi's own
//! commands are not filtered by origin. A link with no `target`, or a download link to another
//! origin (browsers then ignore `download` and navigate), would otherwise load a server's page in
//! the main window (docs/audits/2026-11-hostile-server-audit.md, D1/D2 and review finding F2).
//! This guard refuses any navigation away from the bundle. On Linux and macOS the same hook also
//! sees iframe navigations; the desktop CSP already refuses frames from other origins (no
//! `frame-src`, so `default-src 'self'`), so nothing that works today is lost.

/// Navigations the guard lets through: the app's own pages, and the blank/srcdoc documents a
/// page creates for itself.
pub(crate) fn allowed_navigation(url: &url::Url, development: bool) -> bool {
    crate::hosting::bundled_origin(url, development)
        || (url.scheme() == "about" && matches!(url.path(), "blank" | "srcdoc"))
}

pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("wabi-navigation-guard")
        .on_navigation(|_webview, url| {
            let allowed = allowed_navigation(url, cfg!(debug_assertions));
            if !allowed {
                log::warn!("Blocked a navigation away from Wabi's bundled pages: {}", url.scheme());
            }
            allowed
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::allowed_navigation;

    #[test]
    fn navigation_stays_on_the_bundle() {
        let own = if cfg!(any(windows, target_os = "android")) { "http://tauri.localhost/chat" } else { "tauri://localhost/chat" };
        assert!(allowed_navigation(&url::Url::parse(own).unwrap(), false));
        assert!(allowed_navigation(&url::Url::parse("about:blank").unwrap(), false));
        for target in [
            "https://wabi.example/api/addons/lore/repos/1/files/a",
            "http://127.0.0.1:3001/",
            "javascript:alert(1)",
            "data:text/html,hi",
            "blob:https://wabi.example/1",
            "file:///etc/passwd",
            "about:config",
            "http://localhost:5173/",
        ] {
            assert!(!allowed_navigation(&url::Url::parse(target).unwrap(), false), "{target}");
        }
        assert!(allowed_navigation(&url::Url::parse("http://localhost:5173/").unwrap(), true));
    }
}
