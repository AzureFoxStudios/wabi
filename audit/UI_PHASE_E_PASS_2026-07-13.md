# UI Phase E Pass — 2026-07-13

_Frontend-only Run E: Item 4 (browser QA pass), Item 5 (ambient right-panel surface polish), Item 6 (whiteboard call-adjacent jam layout). No backend / sockets / crypto / calling implementation touched._

## Files changed

### Item 5 — ambient right-panel surface polish (token-driven, reduced-motion guarded, mono micro-labels, hover lift)
- `src/styles/components/map-workspace-part1.css` — added reduced-motion-guarded hover lift (1px translate + accent tint + hairline) to `.place-item` / `.poi-item` / `.poi-editor-item`; made `.detail-stat span` a mono uppercase micro-label.
- `src/styles/components/map-workspace-part2.css` — added `@media (prefers-reduced-motion: reduce)` guard disabling the new transform lift (transform only; color/border still transition).
- `src/lib/components/TransferCard.svelte` — bumped card padding into the 12–16px band (0.45rem→0.7rem) and radius 8→10px; added reduced-motion-guarded hover lift; `.stat-label` + `.card-status` are now mono micro-labels.
- `src/lib/components/TransferCenter.svelte` — nudged container/section spacing into the 12–16px band (`.transfer-center` 0.5→0.6rem, `.tc-content` gap 0.35→0.6rem).
- `src/lib/components/media-albums/MediaAlbumsTab.layout.css` — added reduced-motion guard for the existing `.album-card` hover transform.
- `src/lib/components/UserListTabImpl.css` — added reduced-motion guard so the existing `.user-row` hover lift does not translate under reduced motion.

All four ambient surfaces were already token-driven and rounded/hairline from prior runs (Run D / earlier). The above brings them to a consistent language: 12–16px card/row & ~20px section spacing, mono micro-labels where useful, hover lift guarded by `prefers-reduced-motion`, and `--accent-primary-color` / accent tokens (no hardcoded brand colors).

### Item 6 — whiteboard call-adjacent jam layout (visual only)
- `src/lib/components/WhiteboardTab.svelte`
  - Added a participant/presence strip (overlapping initial-avatars colored by `user.color`, with a `+N` overflow chip) built from `presence` + the local user. Reuses existing presence data; no new socket/calling wiring.
  - Added a clearly-non-functional **"Jam"** call stub: `aria-disabled`, `tabindex="-1"`, tooltip "preview only — not connected", and no click handler — it cannot start a call or open a modal.
  - Added matching token-driven CSS with a reduced-motion guard.
  - Layout preserved: tools lead (left), layers trail (right), canvas center.

## Item 4 — code-path QA (read-only confirmations)
All three flagged risks confirmed by reading source (no runtime browser available in repo):
- **(a) Admin stub flash** — `WorkspacePanelHost.svelte`: the `admin` branch is a reactive side-effect `layoutStore.showAdminCenterStage()` and renders **nothing** (empty comment node). No intermediate admin stub is mounted. ✅
- **(b) Center DM two-column mobile swap** — `MainLayout.svelte` (`@media (max-width:768px)`): `.center-dm-list` is `display:none` by default and only shown via `.center-dm-layout:not(:has(.center-dm-thread .dm-conversation)) .center-dm-list { display:flex }` — i.e. list shows when no conversation is open in the thread, thread shows when one is. Logic correct. ✅
- **(c) Whiteboard LIVE pill at runtime** — `WhiteboardTab.svelte` publishes `setWhiteboardPresence(channelId, presence)`; `ChannelSidebar.svelte` derives `liveWhiteboardChannelIds` from `$whiteboardPresence` filtered to `users.length > 0`; `TextChannelList.svelte` (two sites) and `GalleryChannelList.svelte` render the LIVE pill via `liveWhiteboardChannelIds.has(channel.id)` — so it only appears when presence > 0. ✅

**Run D regression confirmed via grep:** `--accent-primary-color` tokenization present (`chat-core.css` + 10+ surfaces); "More" chip present (`MessageFileContent.svelte`, `CalendarImpl.svelte`); `prefers-reduced-motion` guards present in 10 CSS files.

**QA checklist doc:** `/var/home/Ronin/wabi/UI_QA_CHECKLIST_2026-07-13.md` (concrete browser click-through with expected results for A–G above).

## Verification
- `bun run check`: **0 errors**, 75 warnings, 32 files — matches the PRE baseline exactly. Run E introduced 0 errors. (The 3 errors my first `WhiteboardTab` edit produced — a type annotation in a reactive block — were fixed via a type assertion (`as WhiteboardPresenceUser`).)
- `bun run build`: **passes** (`✓ built`, adapter-node, no build-blocking errors).
- Note: an intermediate `svelte-check` re-run surfaced 11 transient type errors inside `src/lib/components/admin/ServerPolicyPanel.svelte` (admin API / `shared/` contract generics). These were a **stale incremental-type-cache artifact** — a clean follow-up `bun run check` returns 0 errors, confirming Run E introduces no errors and the admin surface is untouched.

## Remaining risks
1. The "Jam" call stub is intentionally inert — if a future run wants a real call affordance, it should wire to `CallModal` deliberately (out of scope for Run E per the "visual adjacency only" constraint).
2. (Resolved) An intermediate `svelte-check` pass showed 11 admin-API/contract type errors; a clean re-run confirms these were a stale incremental-type-cache artifact and the final state is 0 errors. No follow-up needed for Run E.
