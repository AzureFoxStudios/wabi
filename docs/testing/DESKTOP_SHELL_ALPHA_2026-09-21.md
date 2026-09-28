# Desktop shell alpha audit — 2026-09-21

Scope: `/var/home/Ronin/wabi`, branch `crash-harness-hardening`, base HEAD `dcfa8a3b986eba964929cac10f94d9994744aef8`, including existing uncommitted hosting/Tailcat/UI work. This task did not commit, push, deploy, or replace distributed installers. No CSS redesign.

**Verdict: core shell defects repaired; not an unconditional cross-platform alpha sign-off.** The existing Tailcat report still labels direct reconnect unresolved. Windows/macOS installation/runtime, physical suspend/network changes, native menu/tray interaction and active media/transfer acceptance remain open. These are not implied by a compiling Linux candidate.

## ALPHA BLOCKERS FIXED

- The main window disabled decorations without implementing a custom titlebar. Restored native decorations in production and host-test configuration, retaining transparency and content styling. Native platform chrome owns buttons, dragging, double-click and maximize state; no competing custom titlebar. Minimum window size is 480×360.
- Added desktop-only single-instance registration before other plugins. A second normal launch restores/unminimizes/focuses the existing main window instead of initializing another host/tray. macOS Dock reopen uses the same path. No new URL argument protocol is interpreted.
- Removed the duplicate config-created tray. The one programmatic tray provides Show, Hide to Tray, Settings and Quit. Close **minimizes**, keeping the taskbar restore path available even without a visible Linux tray host. Only explicit Quit exits and drains owned services. Tray construction failure logs a warning rather than aborting startup.
- Quit now invokes existing Tailcat disconnect after the existing Authority shutdown path. Minimize/close/hide do not disconnect transport or stop hosting. Changed the debug detached-viewer demo to explicit `WABI_RUN_VIEWER_TEST=1` opt-in.
- Native notifications were blocked by missing IPC permissions and by checking browser `Notification.permission` before reaching the native path. Granted only the three notification permissions actually used, and removed that browser prerequisite for native message/call notifications. Browser permission checks remain intact.
- Corrected desktop Tailcat binary lookup to include Tauri's installed executable-adjacent sidecar, including `tailcat.exe` on Windows, before resource/legacy/PATH fallbacks. No Tailcat protocol or reconnect algorithm change.
- Replaced placeholder menu actions with compact Wabi/Edit/View/Window menus: existing Settings, native About/version, log directory, explicit Quit, standard editing, fullscreen, bounded zoom/reset, show/minimize. Settings opens the existing workspace modal; before entering a community it explains that sign-in is required. Settings listener cleans up on unmount.

## VERIFIED WORKING

- Linux native candidate launches with decorations and a visible conventional menu bar. Small webview screenshot confirms usable community-entry controls at the minimum width.
- Real window-manager maximize/restore and close-to-minimize, unchanged hosted Authority readiness after close, second-process exit and restoration of the first process/Authority are exercised by `scripts/desktop-shell-native-smoke.mjs`.
- Native notification permission invocation is allowed. Regression tests cover absent browser Notification API, denied browser permission with native notifications, and continued browser permission enforcement.
- Existing native proxy bidirectional upgrade regression passes along with hosting lifecycle/archive/process tests. This proves the local upgrade regression, not field reconnect or media quality.
- Source audit: Wabi product/identifier, version 0.1.0 in both desktop manifests, PNG/ICO/ICNS assets, Linux deb/rpm/AppImage and Windows NSIS/MSI configuration, and canonical CI staging of both Authority and Tailcat exist. No automatic login/startup service is installed.

## NON-BLOCKING GAPS / POST-ALPHA

- Native notification destination activation: the locked notification plugin's desktop implementation sends title/body/icon/sound but has no desktop action callback wired to Wabi. Existing browser/PWA navigation callbacks are not carried through the native helper. DM/call destination restoration and OS URL protocol registration remain unimplemented; do not advertise them. Implementing a new native notification backend is outside this audit.
- No new tray mute/deafen integration: existing calling controls remain in the workspace.
- Legacy `scripts/build-native.sh` references nonexistent `frontend/src-tauri`, assumes the wrong Windows executable name, and omits sidecar staging. Canonical build documentation and CI use the correct root path; this stale helper is not a release pipeline.
- Raspberry Pi/ARM/32-bit and NAS appliances are not certified targets merely because a source/container build path exists. Installer signing/notarization, clean-machine upgrades/uninstall and native Wayland GPU behavior remain unverified.

### Open release risks (not downgraded to post-alpha)

- `docs/testing/TAILCAT_HARDENING_2026-09-21.md` explicitly reports **P0 direct reconnect unresolved**, despite the lifecycle-publication race fix. Do not infer completion from another task. The current shell changes neither fix nor reclassify that result.
- Desktop `tailcat_status` reports child liveness rather than proven end-to-end connectivity; the member Settings card only refreshes on mount/actions. No desktop wake/network hook verifies that transport is usable. Socket reconnect uses the existing retry/backoff path. Physical suspend/resume, network switching and killed-helper recovery need a dedicated field run. No host network was disrupted for this audit.
- Native menu/tray clicks and accelerators, Windows/macOS runtime, titlebar double-click, real ongoing calls/transfers during close, and quit while a Tailcat connect is concurrently starting are not certified. Keyboard/mouse injection attempts in the isolated Bazzite Wayland/XWayland session did not activate the menus reliably. The final smoke uses window-manager requests for window state and the existing explicit Quit command; this is not menu/tray interaction coverage.

## HEADLESS STATUS

The standalone Authority is GUI-independent: Rust/Axum/Tokio plus embedded static frontend/WabiDB, with `--host`, `--port`, and `--data-dir`. The deployed server needs no Node, Tauri, GTK, display or external database. Source builds need the frontend assets first.

The already staged Linux Authority was separately launched with DISPLAY, WAYLAND_DISPLAY and DBUS_SESSION_BUS_ADDRESS removed, using disposable storage and a random loopback port: `/readyz` returned HTTP 200 and SIGTERM exited 0. This is a runtime check of the staged binary, not a fresh backend rebuild or a new ARM claim.

Existing Compose supplies persistent storage, ownership initialization, non-root runtime, SELinux `:Z` relabeling, readiness and restart behavior. Optional TURN/SFU/tunnels are separate profiles. Prefer that canonical path on Fedora/Bazzite over a bare `docker run` that omits ownership/relabel setup. CLI/container operation is appropriate for a supported VPS/NAS host; no GUI dependency was found that blocks headless alpha. Desktop-host mode itself remains tied to the desktop process and intentionally does not install a system service. `wabi-serve` is a documentation pointer, not a functioning launcher.

## TEST/BUILD RESULTS

- `cargo check --locked --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol`: passed.
- `cargo build --locked --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol`: passed; Linux debug executable, not a release installer.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol --lib`: **39 passed**; two pre-existing unused-item warnings in tailcat_proxy.
- `bun run check`: **0 errors, 132 warnings across 45 files**.
- `bun run build:tauri`: passed.
- `node --test scripts/tests/desktop-host-foundation.test.mjs scripts/tests/desktop-host-invites.test.mjs`: **18 passed**.
- `bun test src/lib/desktopHostFlow.test.ts`: **9 passed**.
- `bun test src/lib/desktopNotifications.test.ts`: isolation wrapper passed; **3 actual regressions passed** in its child process.
- `git diff --check`: passed.
- Native smoke: see appended result below. Uses the real Bazzite desktop through XWayland/WebKitWebDriver, separate D-Bus session, disposable profile, `WEBKIT_DISABLE_DMABUF_RENDERER=1`; not native-Wayland or Windows certification. Early harness attempts selected auxiliary X windows or read Tauri's cached fullscreen value for an external WM transition; final harness selects the managed PID/window and inspects WM fullscreen state.

## Exact files / commits changed by this task

No commits created. Existing work was kept in place. The companion task-only patch is relative to the captured working-tree baseline, not HEAD, so it excludes the pre-existing hosting/Tailcat/UI changes.

- `src-tauri/Cargo.toml` — desktop-only single-instance dependency.
- `src-tauri/Cargo.lock` — locked single-instance 2.4.5.
- `src-tauri/tauri.conf.json` — native chrome, minimum size, remove duplicate tray configuration.
- `src-tauri/tauri.hosttest.conf.json` — matching native chrome/minimum size.
- `src-tauri/capabilities/default.json` — three notification permissions.
- `src-tauri/src/desktop.rs` — menus/tray/close/restore and zoom regression.
- `src-tauri/src/lib.rs` — single instance, explicit demo opt-in, macOS reopen, Tailcat shutdown.
- `src-tauri/src/tailcat.rs` — installed sidecar lookup.
- `frontend/src/lib/components/MainLayout.svelte` — existing Settings event listener.
- `frontend/src/lib/notificationDisplay.ts` — native permission gating.
- `frontend/src/lib/tauri-notifications.ts` — remove misleading fallback log claim.
- `frontend/src/lib/desktopNotifications.test.ts` — isolated behavioral regressions.
- `scripts/desktop-shell-native-smoke.mjs` — disposable native lifecycle regression.
- `docs/testing/DESKTOP_SHELL_ALPHA_2026-09-21.md` — this report.

API behavior was checked against the installed locked Rust sources and official [window-menu](https://v2.tauri.app/learn/window-menu/), [configuration](https://v2.tauri.app/reference/config/) and [notification](https://v2.tauri.app/plugin/notification/) documentation. Source/runtime evidence above takes precedence over generic platform capability claims.

### Final native result

**PASS** — `dbus-run-session -- node scripts/desktop-shell-native-smoke.mjs /var/home/Ronin/wabi/src-tauri/target/debug/wabi-desktop` exited 0. Verified native decorations, notification IPC permission, maximize/restore, 480px window, close-to-minimize with Authority still ready, second launch restoring the same instance, window-manager fullscreen/restore, and explicit Quit stopping both desktop and Authority. Evidence profile: `/tmp/wabi-native-host-NPkW8S`. Menu/accelerator/tray clicks remain manual checks; no physical media call was made.

Tool versions: Rust repository-pinned 1.93; available Bun 1.3.12 and Node 22.22.2. CI specifies Bun 1.3.14, so the local frontend result is not a certification of that CI toolchain or clean-machine packaging.

Tested desktop SHA-256: `df22bb5dcc96a17dd675e97bc9620fe1d82735908bab6acdfd63620a6de2add5`.
Tested staged Authority SHA-256: `7c5e19b0d5f91f089ad01431a0c2ca22e806e27a9dd825bc42ef65229d08b0d4`.
