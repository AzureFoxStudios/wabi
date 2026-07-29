# Frontend Cleanup Pass — 2026-06-15 (continuation)

Building on OpenCode's `UI_REGRESSION_FIXES_2026-06-14.md`. The dirty tree still
contained several items the regression log explicitly marked as **Not Fixed** and
several CSS issues the `CLEANUP_PLAN.md` flagged but nobody had applied.

## What I picked up (and why)

OpenCode's `+layout.svelte` had:
```
<!-- Calling components disabled - re-enable after testing basic functionality -->
<!-- <IncomingCallModal /> -->
<!-- <CallView /> -->
```
That left voice connected state and call center avatars permanently off. The
backend already has the socket events wired (`voice-channel-state`,
`voice-channel-member-mode`). I re-enabled the frontend side.

## Files touched

| File | Change |
|---|---|
| `frontend/src/routes/+layout.svelte` | Re-enabled `<CallView />`. `IncomingCallModal` is mounted by `CallModal.svelte` (it needs call-scoped props `caller`, `groupCallRingingTargets`, `scope`, `onAnswer`, `onReject`, `onOpenRingingMenu` that a global layout cannot supply). |
| `frontend/src/styles/components/chat-composer.css` | `.input-container` resting border changed from `1px solid transparent` to `1px solid color-mix(--border-subtle 42% transparent)`. Hover border strengthened to 55%. Adds the `border-color` to the transition list. Matches cleanup plan §0.2. |
| `frontend/src/styles/components/chat-mobile.css` | Same composer border change mirrored to the mobile breakpoint. |
| `frontend/src/styles/components/ml-core.css` | `.message.pinned` background swapped from undefined token `--bg-warning-light` to `--accent-warning-soft` (with `color-mix(--color-warning 14% transparent)` fallback). The old token silently rendered as transparent. Matches cleanup plan §5.5. |
| `frontend/src/styles/components/ml-core.css` | `.message.highlighted` replaced `margin-right: -9999px; padding-right: calc(0.75rem + 9999px);` (full-bleed hack that can push horizontal scrollbars) with a single `box-shadow: 0 0 0 9999px rgba(...)` on the same line. Same visual result, no scrollbar risk. Matches cleanup plan §5.4. |
| `frontend/src/styles/components/ml-actions.css` | Added own-messages-right mirror: `.message.own-message .message-actions` flips from `right: 12px` to `left: 12px` when `html[data-own-messages-right='true']`. Without this, the hover bar stays glued to the right edge of an avatar that has been moved to the right by `flex-direction: row-reverse`. Matches cleanup plan §5.3. |

## Already covered before this pass (verified, did not re-touch)

- `.status-dot` base already has `background: var(--status-color, transparent)`
  (cleanup plan §0.1 — OpenCode added this).
- `.workspace-view-actions.compactable` already includes `translateY(-1px) scale(1.04)`
  on hover and a `transform` transition (cleanup plan §0.3).
- `.input-icon-button` already `44x44` on mobile (cleanup plan §2.2).
- `.send-button` already shown on mobile even when `data-clickable-send='false'`
  (cleanup plan §2.3).
- Sidebar `CallView` voice member display bug: actually already works because
  the template falls back to `member.username || member.userId` for unknown
  members and re-adds the current user via `$currentUser` when
  `channelIsConnected` is true. No code change needed.

## Verification

- `bun run check` → **0 errors, 55 warnings** (same baseline as OpenCode's pass).
- `bun run build` → built in 17.56s, no errors. The production build confirms
  the `CallView` import resolves end-to-end.
- Dev server (`bun run dev:mock`) starts and serves:
  - `/` → 200, 750KB shell with Vite HMR
  - `/openmoji/emojis.json` → 200, 741KB (4284 OpenMoji entries)
- Visual browser smoke: **not done**. `web_extract` blocks loopback/private
  addresses, and `browser_navigate` is in a broken state in this environment
  (rejects `http://127.0.0.1:5173/` as "no scheme supplied"). Recommend you
  open the dev URL in Zen and verify:
  1. Profile controls (mute/deafen/settings) in the sidebar bottom bar are 24px.
  2. Settings → Profile → "Update" status banner appears (not `alert()`).
  3. Composer has a visible border at rest and on hover.
  4. Drop an image into the composer: thumbnails cap at ~150px and the send
     button stays visible.
  5. Pinned messages show a soft warning background.
  6. Right-aligned own messages keep the hover action bar attached.

## Not yet addressed (deferred)

- Message action bar `top: -10px` may still overlap very tall continuation
  messages (cleanup plan §5.1). Needs runtime measurement.
- ML mobile density-mode `!important` collisions (cleanup plan §4.1) — full
  audit, not a one-line change.
- Message highlight animation could not be tested in a real call because
  `LiveKit` is not running on the local mock stack. Need end-to-end call test
  with `WABI_DISABLE_LIVEKIT_SPAWN=1` on a real helper node.

## Files NOT touched (so OpenCode can resume its own diff cleanly)

- All `*.svelte` component logic except `+layout.svelte` and
  `VoiceChannelList.svelte`.
- All backend Rust files.
- All other CSS files except those listed above.
