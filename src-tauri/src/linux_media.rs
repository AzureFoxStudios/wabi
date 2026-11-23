//! Linux webview media: permission answers and the NVIDIA rendering workaround.
//!
//! WebKitGTK asks its embedder before a page may list or open capture devices
//! and refuses when nobody answers. wry connects no handler, so without this
//! module every `getUserMedia` call in the desktop app fails with
//! `NotAllowedError`. Evidence and limits are in
//! `docs/plans/2026-11-20-linux-desktop-media.md`.

use tauri::WebviewWindow;
use webkit2gtk::{
    glib::prelude::*, DeviceInfoPermissionRequest, PermissionRequestExt, SettingsExt,
    UserMediaPermissionRequest, WebViewExt,
};

/// The packaged app's origin. The shell never navigates the main window
/// anywhere else, so any other page that ends up there keeps WebKit's refusal.
const PACKAGED_ORIGIN: &str = "tauri://localhost";
/// The Vite dev server `tauri dev` loads (`build.devUrl`). Debug builds only.
#[cfg(debug_assertions)]
const DEV_ORIGIN: &str = "http://localhost:5173";

fn uri_has_origin(uri: &str, origin: &str) -> bool {
    uri.strip_prefix(origin).is_some_and(|rest| {
        rest.is_empty() || rest.starts_with('/') || rest.starts_with('?') || rest.starts_with('#')
    })
}

fn is_app_origin(uri: &str) -> bool {
    if uri_has_origin(uri, PACKAGED_ORIGIN) {
        return true;
    }
    #[cfg(debug_assertions)]
    if uri_has_origin(uri, DEV_ORIGIN) {
        return true;
    }
    false
}

/// Answer WebKit's capture-device permission requests for the app's own page.
///
/// Microphone, camera and screen requests arrive as `UserMediaPermissionRequest`
/// and device-list requests (labels in `enumerateDevices`) as
/// `DeviceInfoPermissionRequest`. Cameras and screens still go through the
/// desktop's own portal prompt afterwards; this only removes the embedder's
/// silent refusal. Every other request type is left to WebKit's default.
pub fn install(window: &WebviewWindow) -> tauri::Result<()> {
    #[cfg(debug_assertions)]
    let selftest_window = window.clone();
    window.with_webview(move |platform| {
        let webview = platform.inner();
        if let Some(settings) = WebViewExt::settings(&webview) {
            // Off by default before WebKitGTK 2.46; without it the page has
            // no `navigator.mediaDevices` at all.
            settings.set_enable_media_stream(true);
        }
        #[cfg(debug_assertions)]
        let answer = std::env::var_os(selftest::NO_HANDLER).is_none();
        #[cfg(not(debug_assertions))]
        let answer = true;
        if answer {
            webview.connect_permission_request(|webview, request| {
                if !request.is::<UserMediaPermissionRequest>()
                    && !request.is::<DeviceInfoPermissionRequest>()
                {
                    return false;
                }
                let uri = webview.uri();
                if uri.as_deref().is_some_and(is_app_origin) {
                    request.allow();
                } else {
                    log::warn!(
                        "Refused a capture-device request from a page outside the app: {}",
                        uri.as_deref().unwrap_or("unknown")
                    );
                    request.deny();
                }
                true
            });
        }
        #[cfg(debug_assertions)]
        selftest::install(&webview, selftest_window);
    })
}

/// Variables that already choose a rendering path. If one is set, the person
/// or their launcher has decided and the shell leaves the environment alone.
const RENDERING_OVERRIDES: [&str; 4] = [
    "__NV_DISABLE_EXPLICIT_SYNC",
    "WEBKIT_DISABLE_DMABUF_RENDERER",
    "WEBKIT_DMABUF_RENDERER_FORCE_SHM",
    "WEBKIT_DISABLE_COMPOSITING_MODE",
];
/// Set to skip every rendering workaround below.
const SKIP_WORKAROUNDS: &str = "WABI_NO_GPU_WORKAROUNDS";

fn needs_nvidia_explicit_sync_workaround(
    env: impl Fn(&str) -> Option<String>,
    nvidia_driver_loaded: bool,
) -> bool {
    if !nvidia_driver_loaded || env(SKIP_WORKAROUNDS).is_some() {
        return false;
    }
    if RENDERING_OVERRIDES.iter().any(|name| env(name).is_some()) {
        return false;
    }
    let wayland_session =
        env("WAYLAND_DISPLAY").is_some() || env("XDG_SESSION_TYPE").as_deref() == Some("wayland");
    // GTK takes the first backend that works; a list led by x11 is an X11 window.
    let forced_x11 =
        env("GDK_BACKEND").is_some_and(|backends| backends.split(',').next() == Some("x11"));
    wayland_session && !forced_x11
}

/// Call first in `run()`, before GTK or any thread exists.
///
/// On the NVIDIA proprietary driver under Wayland the window dies within a
/// second with "Error 71 (Protocol error) dispatching to Wayland display".
/// The usual advice, `WEBKIT_DISABLE_DMABUF_RENDERER=1`, keeps the window but
/// leaves the web process without a GL display, and WebKitGTK 2.54 then aborts
/// on WebCodecs video. Turning off the driver's explicit sync avoids both.
/// Measured on one machine (driver 615, KWin, WebKitGTK 2.54.1); set
/// `WABI_NO_GPU_WORKAROUNDS=1` if it misbehaves elsewhere.
pub fn apply_rendering_workarounds() {
    let nvidia_driver_loaded = std::path::Path::new("/proc/driver/nvidia/version").exists();
    if needs_nvidia_explicit_sync_workaround(|name| std::env::var(name).ok(), nvidia_driver_loaded)
    {
        eprintln!(
            "[wabi] NVIDIA driver on Wayland: setting __NV_DISABLE_EXPLICIT_SYNC=1 \
             ({SKIP_WORKAROUNDS}=1 skips this)"
        );
        std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
    }
}

/// Debug builds only. `WABI_MEDIA_SELFTEST=/path/report.json` makes the page
/// ask for a microphone once it has loaded and writes what happened, and
/// `WABI_MEDIA_SELFTEST_NO_HANDLER=1` leaves the permission handler out so the
/// same binary shows the refusal. `scripts/desktop-media-native-smoke.mjs`
/// drives both. WebDriver cannot check this: WebKit's automation mode answers
/// media permission itself and never consults the embedder.
#[cfg(debug_assertions)]
mod selftest {
    use std::{cell::Cell, path::PathBuf, rc::Rc};
    use tauri::WebviewWindow;
    use webkit2gtk::{LoadEvent, WebViewExt};

    const REPORT_PATH: &str = "WABI_MEDIA_SELFTEST";
    pub const NO_HANDLER: &str = "WABI_MEDIA_SELFTEST_NO_HANDLER";
    const MARKER: &str = "wabi-media-selftest:";
    // Audio only: a video request could raise the desktop's camera prompt.
    const SCRIPT: &str = r#"(async () => {
  const bounded = (promise, label) => Promise.race([promise, new Promise((_, reject) =>
    setTimeout(() => reject(new Error(label + ' timed out')), 15000))]);
  const report = {
    origin: location.origin, secureContext: window.isSecureContext,
    mediaDevices: typeof navigator.mediaDevices, peerConnection: typeof RTCPeerConnection,
    videoEncoder: typeof VideoEncoder, videoDecoder: typeof VideoDecoder
  };
  try {
    const stream = await bounded(navigator.mediaDevices.getUserMedia({ audio: true, video: false }), 'getUserMedia');
    const track = stream.getAudioTracks()[0];
    report.microphone = { state: track.readyState, labelled: track.label.length > 0 };
    const devices = await bounded(navigator.mediaDevices.enumerateDevices(), 'enumerateDevices');
    report.labelledAudioInputs = devices.filter(d => d.kind === 'audioinput' && d.label.length > 0).length;
    stream.getTracks().forEach(live => live.stop());
  } catch (error) {
    report.microphoneError = error.name || String(error);
  }
  document.title = 'wabi-media-selftest:' + JSON.stringify(report);
})();"#;

    pub fn install(webview: &webkit2gtk::WebView, window: WebviewWindow) {
        let Some(path) = std::env::var_os(REPORT_PATH).map(PathBuf::from) else {
            return;
        };
        let started = Rc::new(Cell::new(false));
        let run: Rc<dyn Fn()> = Rc::new(move || {
            if !started.replace(true) {
                if let Err(error) = window.eval(SCRIPT) {
                    log::warn!("Media self-test could not start: {error}");
                }
            }
        });
        webview.connect_title_notify(move |webview| {
            let title = webview.title();
            if let Some(report) = title
                .as_deref()
                .and_then(|title| title.strip_prefix(MARKER))
            {
                if let Err(error) = std::fs::write(&path, report) {
                    log::warn!("Media self-test report not written: {error}");
                }
            }
        });
        let on_load = run.clone();
        webview.connect_load_changed(move |_, event| {
            if event == LoadEvent::Finished {
                on_load();
            }
        });
        if !webview.is_loading() {
            run();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_app_origin_may_capture() {
        assert!(is_app_origin("tauri://localhost"));
        assert!(is_app_origin("tauri://localhost/"));
        assert!(is_app_origin("tauri://localhost/channels/42?tab=voice#top"));
        for other in [
            "tauri://localhost.example.com/",
            "tauri://localhost:8080/",
            "https://localhost/",
            "https://example.com/tauri://localhost/",
            "http://localhost:51730/",
            "about:blank",
            "",
        ] {
            assert!(!is_app_origin(other), "{other} must not be trusted");
        }
        // The Vite dev server is trusted in debug builds only.
        assert_eq!(
            is_app_origin("http://localhost:5173/"),
            cfg!(debug_assertions)
        );
    }

    fn decide(vars: &[(&str, &str)], nvidia: bool) -> bool {
        needs_nvidia_explicit_sync_workaround(
            |name| {
                vars.iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| value.to_string())
            },
            nvidia,
        )
    }

    #[test]
    fn explicit_sync_workaround_is_narrow() {
        let wayland = ("WAYLAND_DISPLAY", "wayland-0");
        assert!(decide(&[wayland], true));
        assert!(decide(&[("XDG_SESSION_TYPE", "wayland")], true));
        assert!(decide(&[wayland, ("GDK_BACKEND", "wayland,x11")], true));
        // Not NVIDIA, not Wayland, or an X11 window on a Wayland session.
        assert!(!decide(&[wayland], false));
        assert!(!decide(&[("DISPLAY", ":0")], true));
        assert!(!decide(&[wayland, ("GDK_BACKEND", "x11")], true));
        assert!(!decide(&[wayland, ("GDK_BACKEND", "x11,wayland")], true));
        // The person already chose a rendering path, or opted out.
        for chosen in RENDERING_OVERRIDES {
            assert!(
                !decide(&[wayland, (chosen, "1")], true),
                "{chosen} must be respected"
            );
        }
        assert!(!decide(&[wayland, (SKIP_WORKAROUNDS, "1")], true));
    }
}
