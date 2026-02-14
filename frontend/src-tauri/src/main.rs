#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod handlers;

use handlers::{
    save_burndown_chart, load_burndown_chart, save_reminders, load_reminders,
    delete_reminders, get_data_stats, clear_binary_data,
    get_media_runtime_capabilities, set_media_transport_preferences, get_media_transport_preferences,
    get_srt_gateway_runtime_state, start_srt_gateway_simulation, stop_srt_gateway_simulation,
    SrtGatewayState
};
use std::sync::Mutex;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Mutex::new(SrtGatewayState {
            running: false,
            mode: "idle".to_string(),
            updated_at: chrono::Utc::now().timestamp_millis(),
        }))
        .invoke_handler(tauri::generate_handler![
            save_burndown_chart,
            load_burndown_chart,
            save_reminders,
            load_reminders,
            delete_reminders,
            get_data_stats,
            clear_binary_data,
            get_media_runtime_capabilities,
            set_media_transport_preferences,
            get_media_transport_preferences,
            get_srt_gateway_runtime_state,
            start_srt_gateway_simulation,
            stop_srt_gateway_simulation
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
