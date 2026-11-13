#[cfg(not(mobile))]
#[tauri::command]
pub fn open_model_viewer(window: tauri::WebviewWindow, bytes: Vec<u8>) -> Result<(), String> {
    crate::hosting::require_bundled_window(&window)?;
    std::thread::spawn(move || {
        if let Err(e) = crate::viewer::run_viewer(bytes) {
            eprintln!("model viewer failed: {e:#}");
        }
    });
    Ok(())
}

#[cfg(mobile)]
#[tauri::command]
pub fn open_model_viewer(_window: tauri::WebviewWindow, _bytes: Vec<u8>) -> Result<(), String> {
    Err("The separate native model-viewer window is a desktop-only surface. Use the in-app mobile viewport instead.".into())
}
