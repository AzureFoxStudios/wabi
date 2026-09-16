#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(tailcat::TailcatState::default())
        .manage(lore_local::LocalWorkspaceState::default())
        .manage(lore_local::detection::LocalDetectionState::default())
        .plugin(tauri_plugin_dialog::init());

    // Preserve the original desktop plugins without pulling desktop shell
    // behavior into mobile initialization. Register each plugin exactly once.
    #[cfg(not(mobile))]
    let builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_log::Builder::new().build());

    builder
        .setup(|app| {
            #[cfg(all(mobile, debug_assertions))]
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;

            #[cfg(not(mobile))]
            desktop::setup(app)?;

            // The optional viewer self-test must never open a second native
            // window in a release build or on mobile.
            #[cfg(all(debug_assertions, not(mobile)))]
            if std::env::var("WABI_SKIP_VIEWER_TEST").is_err() {
                std::thread::spawn(|| {
                    crate::viewer::dlog("DEBUG: thread spawned, building cube");
                    if let Ok(bytes) = crate::viewer::debug_cube_glb() {
                        if let Err(error) = crate::viewer::run_viewer(bytes) {
                            crate::viewer::dlog(&format!("DEBUG viewer test failed: {error:#}"));
                        }
                    } else {
                        crate::viewer::dlog("DEBUG: cube build failed");
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            shell_commands::greet,
            shell_commands::get_platform,
            shell_commands::open_external_url,
            commands::open_model_viewer,
            recording::save_call_recording,
            tailcat::tailcat_register_key,
            tailcat::tailcat_connect,
            tailcat::tailcat_disconnect,
            tailcat::tailcat_status,
            lore_local::lore_local_choose,
            lore_local::lore_local_scan,
            lore_local::lore_local_save_state,
            lore_local::lore_local_open,
            lore_local::lore_local_publish,
            lore_local::lore_local_pull,
            lore_local::detection::lore_local_watch_poll,
            lore_local::detection::lore_local_watch_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

mod commands;
#[cfg(not(mobile))]
mod desktop;
mod lore_local;
mod recording;
mod shell_commands;
mod tailcat;
pub mod tailcat_proxy;
#[cfg(not(mobile))]
mod viewer;
