# UI Phase C — Whiteboard Studio Skin

Frontend-only Phase C implementation of the whiteboard "studio" visual skin, matched to the
collaborative-whiteboard mockup. No backend, no engine rewrite.

## Files changed

- `src/lib/presenceStore.ts` — Added `whiteboardPresence` writable (`Record<channelId, WhiteboardPresenceUser[]>`)
  plus `setWhiteboardPresence` / `clearWhiteboardPresence` helpers so per-channel board presence is
  observable app-wide.
- `src/lib/components/WhiteboardTab.svelte` — Publishes the active sync session's presence to
  `whiteboardPresence` on every `onPresence` callback and clears it on session teardown.
- `src/lib/components/ChannelSidebar.svelte` — Derives `liveWhiteboardChannelIds` (a Set of channel
  ids with >0 board presences) from `whiteboardPresence` and passes it to the channel lists.
- `src/lib/components/sidebar/TextChannelList.svelte` — New `liveWhiteboardChannelIds` prop; renders
  the LIVE pill on both text and group channel rows.
- `src/lib/components/sidebar/GalleryChannelList.svelte` — New `liveWhiteboardChannelIds` prop;
  renders the LIVE pill on gallery channel rows.
- `src/styles/components/sidebar-channels.css` — Added `.live-pill` / `.live-dot` styles (mono label,
  token-driven green, pulsing dot) with a `prefers-reduced-motion` guard.
- `src/lib/components/WhiteboardToolbar.svelte` — Docked toolbar to the top-LEFT leading edge; added
  hairline borders, accent-on-active, hover lift, and a reduced-motion guard.
- `src/lib/components/WhiteboardCanvas.css` — Added a token-friendly checkerboard background to the
  canvas container (pure CSS, performs under transparent/erased areas).

(Note: `TextChannelList.svelte` and `GalleryChannelList.svelte` were touched only to place the LIVE
pill next to channel rows — the channel rows live in those child components, so it was the only way
to satisfy the "LIVE pill next to a channel row" requirement without touching chat density.)

## What each task did

### C1 — LIVE pill in channel list
A green dot + mono "LIVE" pill appears next to any channel row whose whiteboard currently has active
presences.

### C2 — Studio layout: tools lead, layers trail
The tool toolbar now reads as the leading edge (docked top-left of the canvas); the layer panel
trails on the right. The canvas is the clear center stage. Mono micro-labels already exist via tool
`title` tooltips + shortcut glyphs.

### C3 — Checkerboard transparency
A subtle CSS checkerboard renders under transparent canvas regions so empty/erased areas read as
"canvas" rather than a blank void. Pure CSS, no engine change.

### C4 — Polish pass
Rounded tool buttons with accent on active, hairline borders, consistent spacing, and a hover lift
that is disabled under `prefers-reduced-motion`. All sync/layer/import/export functionality is intact.

## How presence → LIVE was wired (and graceful skip)

`presenceStore.ts` had no per-channel whiteboard presence (only voice/user/server presence). Rather
than fabricate, the existing whiteboard presence already flows into `WhiteboardTab` via the sync
session's `onPresence` callback (`payload.users`). That callback now also calls
`setWhiteboardPresence(activeChannelId, users)`, keyed by the channel id of the active board. On
session destroy, `clearWhiteboardPresence(activeChannelId)` removes the entry.

`ChannelSidebar` subscribes to `whiteboardPresence` and builds `liveWhiteboardChannelIds` from any
entry with `users.length > 0`. The pill only renders when true; if no board has presence the map
stays empty and nothing is shown — no fabricated state.

## Verification

- `bun run check` → **0 errors, 75 warnings** (warnings unchanged from the Phase C baseline of 75; not worsened).
- `bun run build` → success (adapter-node, no errors).

## Remaining risks

- The LIVE pill reflects only the locally-connected sync session's presence for the channel the user
  is currently viewing; it does not aggregate presence from other clients' boards into the sidebar
  globally (that would require server-side board-presence fan-out, which is out of Phase C scope).
- The left-docked toolbar may vertically crowd very short viewports on desktop; the mobile breakpoint
  already collapses it to a centered wrap. If needed, a `max-height`/scroll could be added later.
