# Manual UI QA Checklist — Run E (Items 4/5/6)

_Frontend only. No backend / no headless browser available in repo. This checklist is for a human to click through in a real browser to confirm the visual polish landed correctly._

> Where to open the right panel: the right-dock tab strip (right edge of the app). Open the **People**, **Transfers**, **Albums**, **Map**, and **Whiteboard** tabs there. The center stage is used for the Admin entry and the DM two-column test.

---

## A. Admin stub flash (Item 4a) — code confirmed, manual sanity
- [ ] In the left/server rail, open the **Admin** entry (or its right-panel equivalent).
- [ ] Expected: the center stage flips straight to the **Admin Center** view.
- [ ] Expected: **NO** intermediate "admin stub" surface flashes in the right panel — the right panel stays on whatever it was, or closes, with zero flash of an admin placeholder.
- [ ] Code ref: `src/lib/components/WorkspacePanelHost.svelte` — `admin` branch calls `layoutStore.showAdminCenterStage()` via a reactive side-effect and renders nothing (empty comment node).

## B. Center DM two-column mobile swap (Item 4b) — code confirmed, manual sanity
- [ ] Open DevTools device toolbar, set viewport width **≤ 768px**.
- [ ] Open the **DM / Messages** area in the center (not the side panel).
- [ ] Expected: the **conversation list** is visible and the thread pane is hidden (single column, list only).
- [ ] Tap a conversation. Expected: the **thread** replaces the list (list hidden) — `:has()` swap.
- [ ] Go back / deselect. Expected: the **list returns** (no `.dm-conversation` in the thread → list shown).
- [ ] Code ref: `src/lib/components/MainLayout.svelte` — `@media (max-width: 768px)` with `.center-dm-layout:not(:has(.center-dm-thread .dm-conversation)) .center-dm-list { display: flex }`.

## C. Whiteboard LIVE pill at runtime (Item 4c) — code confirmed, manual sanity
- [ ] As **User A**, open a channel's **Whiteboard** tab (right panel or center).
- [ ] As **User B** (second browser/profile), open the **same channel's whiteboard**.
- [ ] Expected in the **left sidebar** channel list: that channel shows a **LIVE** pill with a pulsing dot.
- [ ] Expected: when **no one** is on the whiteboard, the LIVE pill is **gone** (only renders when presence > 0).
- [ ] Code ref: `WhiteboardTab.svelte` publishes `setWhiteboardPresence(channelId, presence)`; `ChannelSidebar.svelte` builds `liveWhiteboardChannelIds` from `$whiteboardPresence` filtered to `users.length > 0`; `TextChannelList.svelte` (×2) and `GalleryChannelList.svelte` render the pill via `liveWhiteboardChannelIds.has(channel.id)`.

## D. Run D regression spot-checks (confirmed present via grep)
- [ ] **Orange tokenization**: UI accent uses `--accent-primary-color` (token), not a hardcoded brand hex. Spot-check the DM "new message" highlight and active tab accents.
- [ ] **More chip**: long message / file rows show a "More" affordance (e.g. `MessageFileContent.svelte`, `CalendarImpl.svelte`).
- [ ] **Reduced motion**: enable OS "Reduce Motion" (or `prefers-reduced-motion`). Confirm panel hovers, call pulses, and the admin LIVE dot no longer animate/translate.

---

## E. Ambient right-panel polish (Item 5) — what to look for
Open each right-panel surface and confirm the shared language (consistent spacing, rounded cards, hairline borders, mono micro-labels, hover lift that is disabled under reduced motion, token-driven accents — no hardcoded brand colors).

### E1. People / Members list (`UserListTabImpl`)
- [ ] Rows are rounded (≈10px), separated by small gaps, hairline dividers between role groups.
- [ ] Hover: row lifts 1px with a faint accent tint.
- [ ] With Reduce Motion ON: the 1px lift does **not** happen (transform disabled), only color change.
- [ ] Presence dot colors are token-driven (`--status-*`).

### E2. Transfers (`TransferCenter` + `TransferCard`)
- [ ] Cards have ~0.7rem padding, 10px radius, hairline border.
- [ ] Stat labels ("Size / Chunks / Progress / Speed") are **monospace micro-labels**.
- [ ] Status pill ("Transferring / Paused / Complete / Failed") is a mono micro-label, token-tinted.
- [ ] Card hover: subtle 1px lift + accent border (no lift under Reduce Motion).
- [ ] Tabs (Active / Offers / Settings) use the accent for the active state.

### E3. Albums (`MediaAlbumsTab`)
- [ ] Album cards: ~14px radius, hairline border, accent on selected/featured.
- [ ] Hover: border + faint accent fill (no transform under Reduce Motion).
- [ ] Viewer modal is rounded with a hairline border and token-driven backdrop.

### E4. Map workspace (`MapWorkspace`, right-panel `compact` variant)
- [ ] Place / POI rows: rounded (~0.95rem), hairline border, consistent gaps.
- [ ] Hover: 1px lift + accent tint (disabled under Reduce Motion).
- [ ] Detail stat labels are mono uppercase micro-labels.
- [ ] Active row uses the info/accent token, not a hardcoded brand color.

---

## F. Whiteboard call-adjacent jam strip (Item 6) — visual only
- [ ] Open a channel **Whiteboard** tab (center or right panel).
- [ ] In the top bar, next to the channel + "N Active" pills, confirm a **participant strip**: overlapping avatar circles (initials, colored by user color) for everyone present, with a **+N** overflow chip when > 5 people.
- [ ] You (the local user) should appear in the strip.
- [ ] Confirm a **"Jam"** button (phone icon) sits beside the avatars.
- [ ] Expected: the Jam button is a **clearly non-functional stub** — `aria-disabled`, tooltip "preview only — not connected", and clicking it does **nothing** (no call starts, no modal opens). It must NOT initiate real calling.
- [ ] With Reduce Motion ON: the Jam button has no transition (instant color change only).
- [ ] Layout: tools lead (left), layers trail (right), canvas center — the jam strip does not disturb that order.

---

## G. Cross-cutting
- [ ] Right-panel width is **not** clamped smaller; the resize dock still works.
- [ ] Cozy chat density / message rhythm is **unchanged**.
- [ ] No new console errors when flipping through the above.
