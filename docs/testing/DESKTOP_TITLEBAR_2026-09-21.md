# Wabi custom titlebar — 2026-09-21

User-requested visual follow-up to the desktop-shell alpha audit. The steady-state Linux/Windows window now has Wabi chrome and no native menu bar. Native decorations remain configured for startup and are removed only after the main webview mounts its custom controls. macOS keeps its conventional system menu; browser/mobile/detached views do not mount this bar.

## Design and behavior

A 44px palette-aware bar with a small drawn W mark, subtle accent hairline, quiet workspace label, and three upper-right controls. Icons use currentColor and consistent 1.5px strokes (2px beside the semibold wordmark). Controls have 40px hit areas, visible keyboard focus, restrained hover/press feedback and reduced-motion support. Close receives a danger-colored hover and an explicit background-operation tooltip.

The Wabi button opens a compact styled menu: Settings, fullscreen, zoom/reset, logs, About/version, and Quit. Arrow/Home/End navigation, Escape dismissal/focus return, outside-click dismissal and keyboard shortcuts are supported. The menu and tray share the same Rust action path and zoom state. The command validates the local main-window origin; no arbitrary URL/path action was introduced.

Minimize, maximize/restore, close, drag and edge/corner resizing use Tauri window APIs. The installed Tauri drag-region handler owns double-click behavior. Maximize state is queried initially and on resize so the restore icon follows external window changes. Close still minimizes and preserves hosting; Quit still drains owned services. Second-launch restoration remains intact.

The content viewport subtracts the bar height without transforming the root or changing pointer-coordinate systems. Overrides cover entry/hosting/workspace, sidebar, Settings/dialogs, Reader focus mode and narrow-window navigation. Floating panels now snap/maximize below the bar. Browser/mobile viewport bounds remain unchanged.

## Verification

- Frontend typecheck: 0 errors, 132 existing warnings in 45 files; no titlebar warnings.
- Tauri frontend build and locked Linux native build/check: passed.
- Native library tests: 39 passed.
- Floating-panel regression fixture: 2 passed (maximize/snap/drag clamp below chrome; browser/mobile keep full viewport).
- Updated real native smoke: PASS using WebKitWebDriver, disposable profile/community, isolated D-Bus and the Bazzite XWayland session. `WEBKIT_DISABLE_DMABUF_RENDERER=1` remains required for this test environment.
- Native smoke exercises custom control clicks, maximize-to-restore label changes, injected double-click through Tauri's real drag-region handler, minimize, 480px controls, close preserving Authority readiness, second-launch restoration, custom menu zoom/reset, Escape focus return, actual Settings opening, content/sidebar/dialog geometry, fullscreen/F11, and custom menu Quit shutting down both application and Authority.
- Screenshots inspected: normal workspace, custom menu, Settings, and 480×360 workspace. Sidebar footer and compact bottom navigation are visible after their viewport corrections.
- Syntax/diff checks passed. No commit, push, deployment or installer release.

Native smoke command: `dbus-run-session -- node scripts/desktop-shell-native-smoke.mjs /var/home/Ronin/wabi/src-tauri/target/debug/wabi-desktop`.

Not verified: Windows/macOS runtime, Windows native snap-layout hover integration, physical pointer drag/resize gestures, all theme variants, 10%-speed motion inspection, and field sleep/network/call behavior. Those are not implied by the Linux smoke. The earlier Tailcat direct-reconnect risk remains outside this visual change.

## Interface review

Full review scope: custom main-window chrome and affected viewport boundaries. Svelte 5 runes, existing plain CSS/tokens, inline SVG, Tauri 2 APIs; no new styling/icon/animation dependency.

| Category | Evidence | Result |
|---|---|---|
| Typography | Native screenshots; wordmark, caption and menu CSS | Quiet hierarchy; percentage/version use tabular numerals |
| Surfaces | Native menu, Settings and 480px screenshots | Theme tokens, 40px controls, rounded menu and structural divider |
| Animations | Source, live resize/icon changes | Explicit 120ms transitions and reduced motion; slow-motion replay unverified |
| Icons | Source and native maximize/restore test | One SVG set, currentColor, state-specific restore icon |
| Performance | Imports and transition properties | No new dependency, no transition-all or unnecessary will-change |

| Severity | Location | Before | After | Why |
|---|---|---|---|---|
| Medium | DesktopTitlebar + desktop.rs | Native frame/menu bar | Custom controls and compact Wabi menu | Requested appearance with accessible hit areas and focus |
| High | desktop-shell.css | Full viewport roots under a new 44px bar | Available-height overrides for workspace/sidebar/Reader/dialogs | Prevent clipped footer and pagination controls |
| High | floatingPanelStore.ts | Snap/maximize at y=0 | Desktop bounds start below chrome | Keep floating-panel close/restore reachable |

Considered and rejected: a large glow/entrance animation (distraction on every launch), a new icon library (unnecessary dependency for four simple glyphs), and transforming the entire workspace (breaks viewport-positioned popouts and portals).

No remaining actionable findings in the inspected Linux surface. Verdict: **Approve for tested scope**, with the platform/gesture/theme/motion checks above explicitly unverified.
