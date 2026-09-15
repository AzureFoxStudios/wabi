#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(tailcat::TailcatState::default())
    .manage(lore_local::LocalWorkspaceState::default())
    .manage(lore_local::detection::LocalDetectionState::default())
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // The detached wgpu model-viewer self-test is intentionally desktop-only
      // and debug-only. Mobile uses the in-app viewport and must never spawn a
      // second native rendering window during ordinary startup.
      #[cfg(all(debug_assertions, not(mobile)))]
      if std::env::var("WABI_SKIP_VIEWER_TEST").is_err() {
        std::thread::spawn(|| {
          crate::viewer::dlog("DEBUG: thread spawned, building cube");
          if let Ok(bytes) = crate::viewer::debug_cube_glb() {
            crate::viewer::dlog("DEBUG: cube built, calling run_viewer");
            if let Err(e) = crate::viewer::run_viewer(bytes) {
              crate::viewer::dlog(&format!("DEBUG viewer test failed: {e:#}"));
            }
          } else {
            crate::viewer::dlog("DEBUG: cube build failed");
          }
        });
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
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
mod recording;
mod tailcat;
mod lore_local;
pub mod tailcat_proxy;
#[cfg(not(mobile))]
mod viewer;
