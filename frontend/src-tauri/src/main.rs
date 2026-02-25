#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod handlers;

use handlers::{
    save_burndown_chart, load_burndown_chart, save_reminders, load_reminders,
    delete_reminders, get_data_stats, clear_binary_data, clear_wabi_data,
    get_media_runtime_capabilities, set_media_transport_preferences, get_media_transport_preferences,
    save_layout_state, load_layout_state
};

fn main() {
    tauri::Builder::default()
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
            save_layout_state,
            load_layout_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
