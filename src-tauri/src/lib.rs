#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(tailcat::TailcatState::default())
        .manage(hosting::HostState::default())
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
            hosting::host_status,
            hosting::host_start,
            hosting::host_stop,
            hosting::host_sharing,
            hosting::host_account,
            hosting::host_invite,
            hosting::host_backup,
            hosting::host_restore,
            hosting::host_open_folder,
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                // Repeated quit requests must not bypass an in-progress drain.
                use std::sync::atomic::{AtomicU8, Ordering};
                static EXIT: AtomicU8 = AtomicU8::new(0);
                if EXIT.load(Ordering::SeqCst) != 2 {
                    api.prevent_exit();
                    if EXIT.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            hosting::shutdown(app.clone()).await;
                            EXIT.store(2, Ordering::SeqCst);
                            app.exit(0);
                        });
                    }
                }
            }
        });
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

mod hosting;
