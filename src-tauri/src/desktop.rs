//! Desktop shell. Closing minimizes; only explicit Quit drains owned services.
use std::sync::Mutex;
use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_dialog::DialogExt;

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit Wabi", true, Some("CmdOrCtrl+Q"))?;
    let about = PredefinedMenuItem::about(app, Some("About Wabi"), Some(AboutMetadata {
        name: Some(app.package_info().name.clone()),
        version: Some(app.package_info().version.to_string()),
        comments: Some("Close minimizes Wabi and keeps calls, transfers and hosted communities running. Quit stops this application and its owned services.".into()),
        ..Default::default()
    }))?;
    let logs = MenuItem::with_id(app, "logs", "Open Logs Folder", true, None::<&str>)?;
    let application = Submenu::with_items(
        app,
        "Wabi",
        true,
        &[
            &about,
            &settings,
            &logs,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let fullscreen = MenuItem::with_id(app, "fullscreen", "Toggle Fullscreen", true, Some("F11"))?;
    let zoom_in = MenuItem::with_id(app, "zoom-in", "Zoom In", true, Some("CmdOrCtrl+Plus"))?;
    let zoom_out = MenuItem::with_id(app, "zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let zoom_reset =
        MenuItem::with_id(app, "zoom-reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[&fullscreen, &zoom_in, &zoom_out, &zoom_reset],
    )?;
    let show = MenuItem::with_id(app, "show", "Show Wabi", true, None::<&str>)?;
    let minimize = MenuItem::with_id(app, "minimize", "Minimize", true, Some("CmdOrCtrl+M"))?;
    let window_menu = Submenu::with_items(app, "Window", true, &[&show, &minimize])?;
    #[cfg(target_os = "macos")]
    app.set_menu(Menu::with_items(
        app,
        &[&application, &edit, &view, &window_menu],
    )?)?;

    #[cfg(not(target_os = "macos"))]
    let _ = (application, edit, view, window_menu);
    app.manage(DesktopShellState(Mutex::new(1.0)));
    app.on_menu_event(|app, event| {
        // Predefined native Edit/About items handle themselves.
        if !matches!(
            event.id.as_ref(),
            "quit"
                | "show"
                | "settings"
                | "logs"
                | "minimize"
                | "hide"
                | "fullscreen"
                | "zoom-in"
                | "zoom-out"
                | "zoom-reset"
        ) {
            return;
        }
        if let Err(error) = perform_action(app, event.id.as_ref()) {
            log::warn!("Desktop menu action failed: {error}");
            app.dialog().message(error).title("Wabi").show(|_| {});
        }
    });

    let hide = MenuItem::with_id(app, "hide", "Hide to Tray", true, None::<&str>)?;
    let tray_menu = Menu::with_items(app, &[&show, &hide, &settings, &quit])?;
    let mut tray = TrayIconBuilder::with_id("wabi")
        .tooltip("Wabi — Close minimizes; Quit stops Wabi")
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    // GNOME and other Linux sessions may not provide an indicator host.
    // Menus, taskbar restore and second-launch restore must work without it.
    if let Err(error) = tray.build(app) {
        log::warn!("System tray unavailable: {error}");
    }
    if let Some(window) = app.get_webview_window("main") {
        let handle = window.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = handle.minimize() {
                    log::warn!("Could not minimize Wabi: {error}");
                }
            }
        });
    }
    Ok(())
}

pub struct DesktopShellState(Mutex<f64>);

// Both the tray/native menu and custom titlebar use the same lifecycle actions.
pub fn perform_action(app: &tauri::AppHandle, action: &str) -> Result<f64, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window unavailable")?;
    let state = app.state::<DesktopShellState>();
    match action {
        "quit" => app.exit(0),
        "show" => show_main(app),
        "settings" => {
            show_main(app);
            window.eval("if (document.querySelector('.app-container')) { window.dispatchEvent(new CustomEvent('wabi:open-settings')); } else { alert('Open a community and sign in to access Settings.'); }").map_err(|e| e.to_string())?;
        }
        "about" => {
            app.dialog().message(format!("Wabi {}\nA place for your people.\n\nClose keeps Wabi running in the background. Choose Quit Wabi to stop the app and its hosted community.", app.package_info().version)).title("About Wabi").show(|_| {});
        }
        "logs" => {
            let path = app.path().app_log_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
            open::that(path).map_err(|e| e.to_string())?;
        }
        "minimize" => window.minimize().map_err(|e| e.to_string())?,
        "hide" => window.hide().map_err(|e| e.to_string())?,
        "fullscreen" => window
            .set_fullscreen(!window.is_fullscreen().map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?,
        "zoom-in" | "zoom-out" | "zoom-reset" => {
            let mut level = state.0.lock().map_err(|e| e.to_string())?;
            let next = next_zoom(*level, action);
            window.set_zoom(next).map_err(|e| e.to_string())?;
            *level = next;
        }
        "zoom-level" => {}
        _ => return Err("Unknown desktop action".into()),
    }
    let level = *state.0.lock().map_err(|e| e.to_string())?;
    Ok(level)
}

pub fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // Show alone does not restore a minimized window.
        for result in [window.show(), window.unminimize(), window.set_focus()] {
            if let Err(error) = result {
                log::warn!("Could not restore Wabi: {error}");
            }
        }
    }
}

fn next_zoom(current: f64, action: &str) -> f64 {
    match action {
        "zoom-in" => (current + 0.1).min(3.0),
        "zoom-out" => (current - 0.1).max(0.5),
        _ => 1.0,
    }
}

#[cfg(test)]
mod tests {
    use super::next_zoom;
    #[test]
    fn zoom_is_bounded_and_resettable() {
        assert_eq!(next_zoom(3.0, "zoom-in"), 3.0);
        assert_eq!(next_zoom(0.5, "zoom-out"), 0.5);
        assert_eq!(next_zoom(2.3, "zoom-reset"), 1.0);
        assert!((next_zoom(1.0, "zoom-in") - 1.1).abs() < f64::EPSILON);
    }
}
