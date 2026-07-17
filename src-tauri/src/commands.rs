#[tauri::command]
pub fn open_model_viewer(bytes: Vec<u8>) -> Result<(), String> {
    std::thread::spawn(move || {
        if let Err(e) = crate::viewer::run_viewer(bytes) {
            eprintln!("model viewer failed: {e:#}");
        }
    });
    Ok(())
}
