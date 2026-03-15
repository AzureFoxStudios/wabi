#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod handlers;

use handlers::{
    save_burndown_chart, load_burndown_chart, save_reminders, load_reminders,
    delete_reminders, get_data_stats, clear_binary_data, clear_wabi_data,
    get_media_runtime_capabilities, set_media_transport_preferences, get_media_transport_preferences,
    set_experimental_stdb_call_enabled, spacechatdb_record_experimental_call,
    save_call_recording, save_layout_state, load_layout_state
};
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    AppHandle, Manager, Runtime, Window, WindowEvent,
};

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
const TRAY_MENU_SHOW_ID: &str = "tray_show_main";
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
const TRAY_MENU_QUIT_ID: &str = "tray_quit_app";

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn restore_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn setup_desktop_tray<R: Runtime>(app: &mut tauri::App<R>) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text(TRAY_MENU_SHOW_ID, "Open Wabi")
        .separator()
        .text(TRAY_MENU_QUIT_ID, "Quit Wabi")
        .build()?;

    let mut tray_builder = tauri::tray::TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false);

    if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon);
    }

    let _tray = tray_builder.build(app)?;
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn handle_desktop_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }

    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
    }
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            save_burndown_chart,
            load_burndown_chart,
            save_reminders,
            load_reminders,
            delete_reminders,
            get_data_stats,
            clear_binary_data,
            clear_wabi_data,
            get_media_runtime_capabilities,
            set_media_transport_preferences,
            get_media_transport_preferences,
            set_experimental_stdb_call_enabled,
            spacechatdb_record_experimental_call,
            save_call_recording,
            save_layout_state,
            load_layout_state
        ]);

    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    let builder = builder
        .setup(|app| {
            setup_desktop_tray(app)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == TRAY_MENU_SHOW_ID {
                restore_main_window(app);
            } else if event.id() == TRAY_MENU_QUIT_ID {
                app.exit(0);
            }
        })
        .on_tray_icon_event(|app, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => restore_main_window(app),
            _ => {}
        })
        .on_window_event(|window, event| {
            handle_desktop_window_event(window, event);
        });

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
