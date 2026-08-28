# Hover-peek popouts (zen glimpse / peek panels)

Session-validated 2026-08-23. Feature request phrasing that triggers this class: "same as zen: automatic panel comes in where you look at the channel briefly in a box and if you click outside of the panel it goes away and if you click on the channel you go to it."

## Implementation map

| Concern | File |
|---|---|
| Peek state + popout render + dismissal | `frontend/src/lib/components/ChannelSidebar.svelte` |
| 500ms dwell timer + anchor rect reporting | `frontend/src/lib/components/sidebar/UnifiedChannelList.svelte` |
| `.channel-glimpse-fixed` variant CSS | `frontend/src/styles/components/sidebar-core-part1.css` |

## Why position:fixed, not absolute

`.channel-list` is `overflow-y:auto`. An absolutely-positioned popout hanging off the sidebar's right edge (`left: calc(100% + ...)`) is CLIPPED by the scroll container — it can never appear outside the sidebar. Render the popout ONCE at the sidebar root with:

```css
.channel-glimpse-popout.channel-glimpse-fixed {
	position: fixed;
	top: auto; left: auto; /* coords come from inline style */
	z-index: calc(var(--z-popout, 1200) + 50);
	max-height: min(420px, 60vh);
	overflow-y: auto;
}
```

Coordinates computed in JS from the anchor row's `getBoundingClientRect()`:
`left = min(rect.right + 12, innerWidth - width - 12)`, `top = clamp(rect.top - 6, 8, innerHeight - 260)`.

## State machine split (child triggers, parent owns state)

- **Child list component** owns the dwell timer: `mouseenter` on a non-voice channel button starts a 500ms timeout capturing `(channelId, rect)`; `mouseleave` or click cancels. Fires `onChannelGlimpseHover(channelId, anchorRect)` callback prop.
- **Parent** owns single `glimpseChannelId` + `glimpsePosition`, renders ONE popout, and handles all dismissal:
  - outside `pointerdown` (allow clicks inside the popover and on `.channel-btn`)
  - Escape keydown
  - ANY scroll: `document.addEventListener('scroll', fn, true)` (capture) — a fixed-position peek detaches from its anchor on scroll, so CLOSE rather than reposition
  - clicking the channel row navigates AND kills the peek (in both child click handler and parent `handleChannelButtonClick`)
- Alt-click remains a manual toggle fallback for keyboard/no-hover users.

## Content hydration without a fetch endpoint

Calling `joinChannel(channelId)` makes the server's socket room-join handler (`core/crates/wabi-server/src/socketio/presence.rs` `on_join_channel`) emit `channel-messages` with the latest ~50-message window straight into the `channelMessages` store. Guard with `if (!get(channelMessages)[id]?.length) joinChannel(id)` to avoid re-joining. This kills the old "open this channel once to cache its window" limitation.

## UX rule from Ronin: NO confirm/open button inside the peek

> "(not sure why we'd need a second button for confirming if we have the natural hyperlink in view already)"

Clicking the channel row IS navigation. Do not put an "Open channel"/"Open group" button inside the box. Keep only genuinely additive actions (Follow toggle stayed). Dismissal paths are click-outside / Esc / scroll / navigate.

## Dead-component trap (why the old glimpse never worked)

The legacy glimpse popout markup lived in `TextChannelList.svelte` + five sibling `*ChannelList` components that were IMPORTED into ChannelSidebar but never RENDERED — only `<UnifiedChannelList>` is instantiated. Alt-click toggled state nothing displayed. Lesson: grep template instantiation (`<ComponentName`), not imports, before extending or debugging a component; the live surface may be a unified replacement missing some old features (and carrying stale tooltips like "Alt-click to glimpse").

## Verification

- `npx svelte-check --threshold error` → expect 0 errors tree-wide.
- Full `npm run build` must pass (exit 0; pre-existing warnings in unrelated files are noise).
- Runtime check needs Ronin's real browser (headless cannot render Wabi — see memory).
