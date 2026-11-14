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
    if crate::hosting::bundled_origin(url, development) {
        return true;
    }
    match url.scheme() {
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        // A save (`<a download href="blob:…">`) is a navigation request on Linux and macOS. Only
        // a page of the bundled origin can mint a blob URL of that origin, so those are the
        // app's own downloads (review finding N2). The inner URL is parsed, not prefix-matched.
        "blob" => url::Url::parse(url.path())
            .is_ok_and(|inner| inner.scheme() != "blob" && crate::hosting::bundled_origin(&inner, development)),
        _ => false,
    }
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

    /// (url, allowed) for this build's platform form of the bundled origin.
    fn table() -> Vec<(String, bool)> {
        let own = if cfg!(any(windows, target_os = "android")) { "http://tauri.localhost" } else { "tauri://localhost" };
        let other_form = if cfg!(any(windows, target_os = "android")) { "tauri://localhost" } else { "http://tauri.localhost" };
        let mut rows: Vec<(String, bool)> = vec![
            (format!("{own}/chat"), true),
            (format!("{own}/"), true),
            (format!("blob:{own}/5f1c2a90-4e1b-4c7a-9d0e-3b2a1c0d9e8f"), true),
            ("about:blank".into(), true),
            ("about:srcdoc".into(), true),
            (format!("{other_form}/chat"), false),
            (format!("blob:{other_form}/5f1c"), false),
            ("blob:https://wabi.example/5f1c".into(), false),
            ("blob:null/5f1c".into(), false),
            (format!("blob:blob:{own}/5f1c"), false),
            ("https://wabi.example/api/addons/lore/repos/1/files/a".into(), false),
            ("http://127.0.0.1:3001/".into(), false),
            ("data:text/html,hi".into(), false),
            ("javascript:alert(1)".into(), false),
            ("file:///etc/passwd".into(), false),
            ("about:config".into(), false),
            ("about:blank/x".into(), false),
            ("steam://run/570".into(), false),
            ("ms-msdt:/id x".into(), false),
            ("smb://host/share".into(), false),
            ("http://localhost:5173/".into(), false),
        ];
        // userinfo, ports, case and a trailing dot on the bundled host
        if cfg!(any(windows, target_os = "android")) {
            rows.extend([
                ("http://user@tauri.localhost/".into(), false),
                ("http://tauri.localhost:8080/".into(), false),
                ("HTTP://TAURI.LOCALHOST/chat".into(), true),
                ("http://tauri.localhost./".into(), false),
                ("blob:http://user@tauri.localhost/5f1c".into(), false),
            ]);
        } else {
            rows.extend([
                ("tauri://user@localhost/".into(), false),
                ("tauri://localhost:8080/".into(), false),
                // Non-special scheme: the host keeps its case, so this is refused (Tauri never emits it).
                ("TAURI://LOCALHOST/chat".into(), false),
                ("tauri://localhost./".into(), false),
                ("blob:tauri://user@localhost/5f1c".into(), false),
            ]);
        }
        rows
    }

    #[test]
    fn navigation_stays_on_the_bundle() {
        for (target, allowed) in table() {
            let url = url::Url::parse(&target).unwrap();
            assert_eq!(allowed_navigation(&url, false), allowed, "{target}");
        }
        assert!(allowed_navigation(&url::Url::parse("http://localhost:5173/").unwrap(), true));
        assert!(!allowed_navigation(&url::Url::parse("http://localhost:5173/").unwrap(), false));
    }
}
