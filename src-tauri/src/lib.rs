#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // DEBUG SELF-TEST: spawn the native viewer with a generated cube so the
      // wgpu window appears without needing the frontend. Remove after verification.
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
    .invoke_handler(tauri::generate_handler![commands::open_model_viewer])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

mod commands;
mod viewer;
