//! Desktop-only shell setup; application state and commands live in lib.rs.
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", "About Wabi", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&about, &settings, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => show_main(app),
            // Preserve the existing placeholder rather than inventing an
            // unrelated About workflow as part of the hosting foundation.
            "about" => {},
            _ => {},
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event {
                show_main(tray.app_handle());
            }
        });
    // A missing optional icon must not panic during application startup.
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
