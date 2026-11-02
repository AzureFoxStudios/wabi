# Design debt sweep and CI triage — 2026-11-02

Branch: `arena/5e6ea3ed-wabi` (from `9088d46`, the Game Sync panel commit). Baseline
`main` is `d283c0b`. Nothing here is pushed or merged; no PR was opened.

Verification actually run in this sandbox (bun 1.4.4, no Rust toolchain, no
browser):

| Check | Result |
| --- | --- |
| `bun test --isolate src/lib` | 2890 pass, 3 skip, 1 fail (the `xlsx` package is not installed — expected) |
| `bun run check` | 4 errors (the four known `xlsx` type errors), 108 warnings, 47 files |
| `STATIC_BUILD=1 bun run build` | succeeds (`adapter-static`, esbuild minifier untouched) |
| `bun run check:i18n` | `en/es/th` key-identical |

## 1. Language strings — done

- `ModeTabsDrawer.svelte`: region label, segmented label, "Recent {count}" /
  "Followed {count}", both list subtitles, both empty states, "{count} unread"
  and "Unfollow {name}" now come from `shortcuts.*` in `en/es/th`.
- `MainLayout.svelte`: "Show/Close channel list", "Open channel sidebar",
  "Resize channel sidebar", "Side panel", "Resize side panel", "Loading panel",
  "Toggle/Close calling diagnostics", "Calling Debug", "Open whiteboard for this
  voice channel" and "Scratchpad" now come from `shell.*`; both files' remaining
  `aria-label` literals were checked (nothing left in `ModeTabsDrawer`).

## 2. Dead or redundant CSS — already clean, verified

- `styles/components/StorageSettings.css` is already gone; `storage-settings.css`
  is the one imported by `styles/styles.css`.
- `styles/components/ml-core.css` no longer has a second `.message` block.
- `UserListTabImpl.css` radii are `--w-pill`, `--radius-inner`, `--radius-md`,
  `--w-avr` and `0` — all on scale. Nothing to do.

## 3. Raw colours and z-index — done

- `styles/components/admin-center-stage.css`: all 83 hex values, the one
  `rgba()`, and all 75 legacy-token reads are now `--w-*` roles (bridge mapping
  in `tokens.css` §"Legacy bridge"), so `hex`/`rgb`/`legacy` are now 0. Two
  side effects worth knowing:
  - `--accent-info-soft`, `--accent-danger-soft` and `--accent-warning-soft`
    were never defined, so the role chips had no fill; they are now
    `color-mix()` tints of `--w-info` / `--w-danger` / `--w-warn`.
  - the `.admin-payment-on` dot glow (`0 0 8px`) is removed (§5/§6: no glows).
- `lib/notesStore.ts`: the six note swatches are `--w-accent`, `--w-ok`,
  `--w-warn`, `--w-danger`, `--w-info`, `--w-mute`. The fifth swatch was a raw
  purple with no role, so it is the info role and the label is now "Blue"
  (`notesView.ts` + the `notesView.test.ts` expectation that lists the words).
- `lib/components/admin/ui/StatusDot.svelte`: `--w-online`, `--w-warn`,
  `--w-danger`, `--w-faint`. Note: nothing imports this component (dead file);
  it was left in place and only de-branded.
- `styles/components/settings-appearance.css` already reads roles only.

## 4. `100vh` stragglers — done

`EmojiPicker.svelte` 553–554 now use `100dvh`. The `:fullscreen` rules and the
`100vh; height: 100dvh` fallback pairs were left alone.

## 5. Design-lint ledger — updated

`admin-center-stage.css`'s ledger line (`hex: 83, rgb: 1, legacy: 75`) is
removed; the lint suite is green, and the ledger-shrinks test proves nothing
climbed back. The other large entries (`windowing.css`,
`map-workspace-part1.css`, `tokens.css`, `public-pages.css`) are untouched.

## 6. Old indigo brand — done

- `static/manifest.webmanifest`: `background_color` / `theme_color` are
  `#101315` (the resolved Wabi Ink page), matching the shell's `theme-color`.
- `static/offline.html`: rewritten on the boot palette (`#101315`, `#1b2125`,
  `#e8e7e0`, `#9aa39d`, `#818983`, `#6a6b6a`), no gradients, no `system-ui`,
  radii from the scale, `100dvh`, accent focus ring. No test or smoke script
  reads those colours.

## 7. Phone side panels — now bottom sheets

- `styles/surfaces/mobile.css`: `.mobile-right-overlay` is a bottom sheet —
  `left: var(--mobile-rail-w)`, bottom-anchored, `height: min(calc(100dvh - 48px),
  760px)`, `--radius-xl` top corners only, `--w-line-strong` top edge, `--w-bg2`,
  `--w-shadow` when open, `env(safe-area-inset-bottom)` padding, 36×4 `--w-pill`
  grabber via `::before`, and a `translateY` slide instead of `translateX`.
  While it is open the nav drops under the scrim (as with a kit dialog) and the
  scrim covers the nav band.
- `MainLayout.svelte`: `getUsersPreviewTransform` and the users branches of the
  touch-swipe machine are gone; `swipePreviewTarget` is `'none' | 'channels'`.
  The sheet no longer carries inline transform/opacity/transition. The canvas
  drawers, the facepile, the stubs, `WorkspaceViewBar` and `ServerHub` still
  open the panel, so nothing is stranded; it closes on the scrim, Escape or its
  own close key.
- Not verified in a browser (no Chromium/Xvfb in this sandbox). Needs a phone
  pass at ≤599 and 600–768 (rail case), plus a check that the panel body
  scrolls inside the sheet.

## 8. Legacy voice list — harness moved, file deleted

- `test/call-panel-browser-harness.ts` mounts `UnifiedChannelList` with the full
  prop set.
- The roster media checks moved to what that list actually draws: per-row
  `.live-tag` counts (the camera has no roster mark in this list) plus per-lane
  assertions on `wabidbRemoteVideoSessions`, so cross-channel isolation is still
  covered.
- `sidebar/VoiceChannelList.svelte` deleted, added to the removed-dead-code list
  in `deadCode.test.ts`, and its now-impossible case dropped from
  `svelte5ReactivityTripwire.test.ts` (the live `UnifiedChannelList` case stays).
- **Unverified:** this harness only runs in a real browser via
  `node scripts/audio-browser-smoke.mjs`; that must be run before merging.

## 9. Overlay marks on shared screens — not attempted

`PresenterOverlayCanvas.svelte` still maps pointer positions into tile pixels
(`canvas` is `inset: 0` over the tile) instead of the shared video's content
box, so a letterboxed 16:9 share draws marks in the bars and "capture to
whiteboard" exports them offset. The fix needs the video's intrinsic size and its
`object-fit` content rect at runtime (offset + uniform scale for points and
stroke widths), and it changes export output. It cannot be verified without a
real screen share, so it was left for a session that can run one.

Suggested shape: pass the `<video>` element's content box up from the tile, keep
overlay elements in video-pixel space, and transform only at draw/capture time.

## 10. CI on `main` — triage

Latest `main` push is `d283c0b` (2026-11-01), not `bc5a1a6`; the list below is
the current state, with the Oct 2 / Oct 11 runs for comparison.

| Check | `d283c0b` (Nov 1) | `bc5a1a6` (Oct 11) | `f9e19e16` (Oct 2) | Step that failed |
| --- | --- | --- | --- | --- |
| CI | **fail** | fail | pass | `Cargo test` → `cargo test --workspace` (exit 101) |
| Build and Release | **fail** | fail | fail | `build-server` → `cargo test --locked --workspace`; `build-tauri (windows)` → `cargo test --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol --lib hosting::` |
| Office workspace acceptance | **pass** | fail | fail | — |

So:

- **CI is new.** The job's frontend steps (unit tests, `svelte-check`, static
  build) and `Cargo check` all pass; only `Cargo test` fails, and it has failed
  since the Oct 11 merge, so the regression landed between `f9e19e16` and
  `bc5a1a6`, not in the Nov 1 phone commit.
- **Build and Release is half new.** `build-server` fails for the same reason as
  CI (identical `cargo test --workspace` step) — new. The Windows
  `build-tauri` failure and its hosting checks already failed on Oct 2 — old.
  The macOS `build-tauri` job that failed on Oct 2 passes now.
- **Office workspace acceptance is green**, contrary to the handoff note: it
  failed on Oct 2 and Oct 11 and was fixed by Nov 1.

Limit of this triage: runner logs live on
`productionresultssa32.blob.core.windows.net`, which this sandbox cannot reach,
so the failing Rust test's name is not readable from here; the annotations only
carry `Process completed with exit code 101`. Since `Cargo check --workspace`
passes while `cargo test --workspace` fails, the failure is either a test-build
error or a failing test. The largest new Rust test surface in the window is
`wabi-consensus` (availability control + runtime, several tests binding
`127.0.0.1:0` and using wall-clock timing) — a suspect, not a conclusion.
Reproduce with `cargo test --workspace` locally.

## 11. Claude Approvals — no such check

There is no Claude Approvals check on this repository: no workflow under
`.github/workflows/` mentions Claude, and the check runs on `main` come from
`github-actions` and `github-advanced-security` (CodeQL) only. The open PRs
(Dependabot) report the same set of checks. So it is neither green nor red — it
is not configured. If a Claude review check is expected, the app has to be
installed on the repo.

## Not touched

`packages/wabi-protocol`, the esbuild minifier, `data/`, and the finished phone
work (nav, calls, DMs badge, facepile, Share in ⋯, report dialog, Activity list).
