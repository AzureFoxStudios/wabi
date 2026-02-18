# Tauri Mobile Implementation (Android + iOS)

This is the actionable implementation checklist to move Wabi from desktop-only Tauri packaging into mobile-capable Tauri v2 packaging.

## 1) Native project bootstrap (must do first)

From `frontend/`:

```bash
npm run tauri-android-init
npm run tauri-ios-init
```

What this should produce:

- Android native project scaffolding (Gradle/Kotlin) under Tauri-generated paths.
- iOS native project scaffolding (Xcode/Swift) under Tauri-generated paths.

Commit the generated project scaffolding, but keep build artifacts ignored.

## 2) Platform config overlays

Added in this repo:

- `frontend/src-tauri/tauri.android.conf.json`
- `frontend/src-tauri/tauri.ios.conf.json`

Current intent:

- Keep shared behavior in `frontend/src-tauri/tauri.conf.json`.
- Use platform overlays for mobile-only bundle targets and identifiers.

Recommended command pattern:

```bash
# Android
npx tauri android build --config src-tauri/tauri.android.conf.json

# iOS
npx tauri ios build --config src-tauri/tauri.ios.conf.json
```

## 3) Toolchain prerequisites by platform

### Android

- Java JDK (17+ recommended)
- Android SDK + NDK
- Android platform/build-tools matching Tauri requirements
- Proper `ANDROID_HOME`/`ANDROID_SDK_ROOT`

### iOS (macOS only)

- Xcode + Command Line Tools
- CocoaPods (if required by generated project)
- Apple signing certificates + provisioning profiles

## 4) Code audit items before shipping mobile

1. **Desktop-only plugin usage**
   - Verify if shell functionality is required on mobile.
   - If not required, gate desktop-only calls in frontend runtime checks.

2. **Media and permissions**
   - Camera/mic/storage permission prompts and denial paths.
   - Foreground/background handling for active calls and recording.

3. **Connectivity robustness**
   - Mobile reconnect/backoff tuning in socket and WebRTC layers.
   - Avoid localhost assumptions for API/call endpoints in mobile builds.

## 5) CI work to add

Minimum matrix extension:

- Android debug build lane on Linux/macOS runner.
- iOS build-validation lane on macOS runner.

Use release-only secure lanes for signing/distribution credentials.

## 6) What has been started in this commit

- Added Android and iOS Tauri overlay config files.
- Added mobile npm scripts in `frontend/package.json`:
  - `tauri-android-init`, `tauri-android-dev`, `tauri-android-build`
  - `tauri-ios-init`, `tauri-ios-dev`, `tauri-ios-build`
- Added this implementation checklist document so contributors can execute the work in order.
