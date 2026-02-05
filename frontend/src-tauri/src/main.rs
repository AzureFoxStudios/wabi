#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod handlers;

use handlers::{
    save_burndown_chart, load_burndown_chart, save_reminders, load_reminders,
    delete_reminders, get_data_stats, clear_binary_data
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
            clear_binary_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
