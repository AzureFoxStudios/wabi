# Tauri build readiness

Updated 2026-09-06. This supersedes the older environment-specific packaging
report. See [audio-flow integrity](../plans/2026-09-06-audio-flow-integrity.md)
for the audio changes and exact verification limits.

## Current source of truth

The native crate and configuration are at repository-root `src-tauri/`, not
`frontend/src-tauri/`. The root config points to `../frontend/build`; its
pre-build command runs `cd frontend && bun run build:tauri`. The desktop
frontend build includes the standalone editor asset check, not just the SPA.

The native bundle requires a real, target-specific Tailcat sidecar matching
`bundle.externalBin`. Do not fake or silently remove it to report a successful
package. The native Rust commands currently do not implement a separate audio
capture/DSP engine; calls use the shared frontend through the platform webview.

## Checks completed in this workspace

- Static web frontend build and desktop frontend build succeeded.
- Frontend typecheck completed with zero errors; existing warnings remain.
- Headful Chromium exercised real codec workers/WASM, AudioWorklet playback,
  local WebRTC media, mute/device replacement, receive handover and DSP resume
  under the actual desktop CSP, using synthetic sources and silent output.
- Normal `cargo check --manifest-path src-tauri/Cargo.toml --locked --offline`
  succeeded after fetching the pinned genuine Tailcat v0.4.0 sidecar with the
  repository's script. The archive checksum matched the published GitHub
  release digest (recorded in the audio work record). Earlier code-only checks
  excluded this sidecar requirement; the final normal check does not.
- The full native release command successfully linked
  `src-tauri/target/release/wabi-desktop`. Debian packaging then failed at
  appindicator discovery: runtime libraries exist on this Bazzite host, but
  their pkg-config development metadata is missing. The tray feature was not
  disabled. No installer was produced or installed.
- Native-window audio verification was not completed; other platforms remain
  unverified. The exact commands and limits are in the audio work record.

The checked-in CSP allows `script-src 'self' 'wasm-unsafe-eval'` and
`worker-src 'self' blob:` for the installed codec. It does not enable general
`unsafe-eval`. Chromium CSP verification is not proof of WebKitGTK, WebView2,
or WKWebView compatibility.

## Remaining release gates

Fetch the pinned sidecar and run the full native build on each supported OS.
Linux needs WebKitGTK/GTK and related development packages; macOS needs Xcode
tooling and signing/notarization for distribution; Windows needs MSVC/SDK
tooling and its own bundle/signing verification.

Use real native windows to verify microphone permission, preferred-device
selection, physical audibility, mute/deafen, screen sound, DSP mode changes,
reconnect, and teardown. Also verify two authenticated Wabi clients across a
network boundary. Local synthetic ICE and a passing frontend build do not
establish those guarantees.
