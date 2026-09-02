# Tauri Build Readiness (Linux / macOS / Windows)

## What was validated

- Ran a full `npm run tauri-build` from `frontend/` to simulate production packaging.
- Ran `npx tauri info` to detect host/tooling prerequisite gaps.
- Reviewed Tauri config and Rust crate setup in `frontend/src-tauri`.

## Current status summary

- **Tauri app wiring is present** (Rust entrypoint, handlers, capabilities, per-OS icon config).
- **Frontend build step succeeds** under Tauri (`vite build` + static adapter output).
- **Linux bundle currently fails** in this environment due to missing native GTK/GLib development libraries (`glib-2.0.pc` not found).
- **Cross-platform hardening updates made**:
  - `identifier` changed from `com.wabi.app` to `com.wabi.desktop` to avoid macOS `.app` naming conflicts.
  - `beforeBuildCommand` / `beforeDevCommand` changed from `bun ...` to `npm run ...` to reduce machine-specific Bun dependency during Tauri builds.

## Expected issues by platform

### Linux

Likely failure classes:

1. Missing WebKitGTK/GLib/native build deps (confirmed here).
2. Missing `pkg-config` paths when libraries are installed in nonstandard locations.

Typical packages (Ubuntu/Debian) that should be present for Tauri v2 desktop builds:

- `libwebkit2gtk-4.1-dev`
- `libgtk-3-dev`
- `libglib2.0-dev`
- `librsvg2-dev`
- `patchelf`

### macOS

Likely failure classes:

1. Missing Xcode Command Line Tools.
2. Apple signing/notarization requirements for distributable builds.
3. Bundle identifier format issues (now mitigated by moving away from `.app` suffix).

### Windows

Likely failure classes:

1. Missing Visual Studio Build Tools (MSVC toolchain).
2. Missing Windows SDK.
3. Code signing requirements for smooth install reputation/trust.

## Additional observations

- `npx tauri info` reported `@tauri-apps/plugin-shell` JavaScript package as not installed while Rust plugin is enabled. This is not always a build blocker, but can become a runtime/dev issue if frontend code imports the JS plugin helpers.
- CSP is intentionally permissive in script/style policy (`unsafe-inline`/`unsafe-eval`) and may need tightening before hardened desktop distribution.

## Suggested CI matrix

Add/maintain CI jobs that run at minimum:

- `npm ci`
- `npm run build`
- `npm run tauri-build` (or `cargo check` in `src-tauri`) on:
  - `ubuntu-latest`
  - `macos-latest`
  - `windows-latest`

and explicitly install platform prerequisites before the Linux/macOS jobs.
