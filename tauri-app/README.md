# Tauri App

This is a newly scaffolded Tauri v2 app in `tauri-app/` with:

- Desktop config for Windows (`src-tauri/tauri.windows.conf.json`)
- Android config (`src-tauri/tauri.android.conf.json`)

## Commands

Run from `tauri-app/`:

- `npm run tauri:dev`
- `npm run tauri:build` (builds desktop app, including Windows `.exe` bundle on Windows)
- `npm run tauri:android:init`
- `npm run tauri:android:build` (builds both APK and AAB)

## Android prerequisites

Android tooling requires Java and Android SDK/NDK setup.  
If `tauri:android:init` fails with Java errors, set `JAVA_HOME` and ensure `java` is on `PATH`.
