// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Desktop and mobile must use the same state and command registrations.
    app_lib::run();
}
