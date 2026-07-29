# UI Phase BC Pass — 2026-07-13

Frontend-only polish pass covering A.5 (admin stub flash fix), Phase B (visual parity / calm defaults), and Admin mockup-enrichment.

## Files changed

- `src/lib/components/WorkspacePanelHost.svelte` — A.5: `admin` branch now triggers `layoutStore.showAdminCenterStage()` as a reactive side-effect and renders an empty fragment. `AdminTab.svelte` is no longer imported/mounted, so the "Opening admin dashboard…" stub never flashes.
- `src/lib/docking/layoutConstants.ts` — B1: reordered `DEFAULT_WORKSPACE_PANEL_IDS` to put the calm ambient strip first (`users, dms, notes, map, media, transfers, admin`) and lowered `DEFAULT_PANEL_OVERFLOW_THRESHOLD` from 5 → 4 so heavy tools (media, transfers, admin) sit behind the overflow row by default.
- `src/lib/components/RightPanel.svelte` — B1: changed default `recentPanelIds` to `['users','dms','notes','map']`.
- `src/lib/notesStore.ts` — B2: added optional `pinned?: boolean` and `color?: string` to `LocalNote` (backward compatible), `NOTE_COLORS` token-mapped swatch palette, and `sortNotesWithPin()` (pinned first, then newest-updated).
- `src/lib/components/NotesWorkspace.svelte` — B2: pin-to-top toggle + inline color-chip picker in both compact and full editor toolbars; pinned rows sort first; list cards / items show a pin glyph and a left color accent. Persists via the existing `writeNotes`/`safeWrite` path. No backend.
- `src/styles/components/admin-center-stage.css` — B3: responsive grid 4→2→1 (added a 1-col breakpoint at ≤560px), bumped section gaps to 20px and card/row gaps to 14–16px, and added a `prefers-reduced-motion` guard that disables card/hover/shine/pulse animations and transforms. Kept the 200px left nav + 48px topbar shell and ~1200px content max-width.
- `src/lib/components/DmHub.svelte` & `src/lib/components/DmListPanel.svelte` — B4: unified the conversation row to one density/language (32px avatar, 9px status dot, ~11px preview, 10px time-ago, 19px unread badge). DmHub was the looser of the two (42px avatar); both now match. No selection-behavior change.

`src/lib/components/AdminTab.svelte` was left as a valid, unused component file (per instructions).

## What each task did

### A.5
Opening admin from the dock flips straight to the centered `AdminCenterStage` with zero intermediate text. The reactive side-effect fires `showAdminCenterStage()` and the right-panel `admin` branch renders nothing visible.

### B1
The default right-panel visible row is now the calm ambient strip `['users','dms','notes','map']`. With `DEFAULT_PANEL_OVERFLOW_THRESHOLD = 4`, heavy tools (media, transfers, admin) are not in the default visible tab row. All capabilities remain reachable through the existing panel drawer ("More" list), which enumerates every panel in the dock — nothing was removed. The resize dock is untouched.

### B2
Notes gained optional pinning (pinned float to top, then newest-updated) and a per-note color accent. Swatches are mapped to theme tokens (`--accent-primary-color`, `--color-success`, `--color-warning`, `--color-danger`, `--accent-purple`, `--text-secondary`), not hardcoded brand colors, and are stored as CSS-var strings on the note so they respect theming. Old notes lacking the fields keep working (fields are optional and `sortNotesWithPin` tolerates `undefined`).

### B3
Admin overview/shell now follows the mockup language: 4→2→1 responsive grid, card hover lift (translateY + deeper shadow) that is suppressed under `prefers-reduced-motion`, mono uppercase tracked section headers (already present, retained), 14–16px card gaps and 20px section gaps, ~1200px content max-width, breathing room. The 200px left nav + 48px topbar shell is preserved.

### B4
`DmHub` and `DmListPanel` now share a single 32px-avatar row density with matching status dot, time-ago, preview size, and unread badge. Selection behavior is unchanged.

## Real admin data surfaced / omitted

- The Overview section already consumes real `DashboardStats` from `GET /api/admin/stats` (users/online/messages/channels/roles/emojis/bans/reports, status distribution, recent audit, role distribution, top contributors). This pass kept that as the single real data source for Overview.
- Inspected `src/lib/api/admin.ts` and `src/lib/components/admin/*`. Additional real endpoints exist (`/api/relays/admin`, compression config/metrics, runtime guardrails, payment blocks, policies) but each is already surfaced in its own dedicated AdminWorkspace section (runtime, payments, gates, etc.), not Overview. No new real field was left un-shown that belonged on the Overview.
- Deliberately omitted from Overview (no backend data / would be fake): no "Phase 2"/"coming soon" walls were added, and no fabricated stats were introduced. If a future real endpoint (e.g. server node info) is wired, it slots into the existing `Card` + `RingGauge`/`Skeleton` structure.

## Verification

- `bun run check` → **0 errors, 75 warnings** (warning count unchanged from the pre-pass baseline of 75; no new warnings introduced by these edits).
- `bun run build` → **success** (built in ~17.5s, adapter-node output produced, no errors).

## Remaining risks

- **Pre-existing behavior, not changed:** existing users with a persisted layout (`localStorage`) keep their old dock order/threshold; the calm-strip default only applies to fresh layouts / after a workspace reset. This matches the "defaults" scope.
- **Overflow reachability relies on the panel drawer:** heavy tools are not rendered as a visible "More" tab row; they live in the existing panel drawer (`togglePanelDrawer`). That is the established overflow mechanism, so capability is preserved, but there is no dedicated "More" chip in the tab row.
- **`/api/admin/stats` availability:** if the backend does not serve that route, Overview shows skeletons (pre-existing condition, unchanged by this pass).
- Admin stub flash fix is verified by code path (no visible node mounted); a manual click-through of "open admin" from the dock is recommended to confirm zero flash in-browser.
