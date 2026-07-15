# UI Phase G Pass — 2026-07-13

Frontend-only polish: Reader typography pass (P1) + QuickResources IA cleanup (P2).
Workdir: `/var/home/Ronin/wabi/frontend`. No backend, no chat-density, no right-panel
width clamp, no commits. DESIGN LAW respected (left=nav / center=work / right=ambient,
token-driven, one accent, `prefers-reduced-motion` guarded).

## Files changed

- `src/styles/components/reader-tab.css` — recalibrated the reading column to a calm,
  consistent prose width; mono hairline micro-labels on metadata; added a single
  accent-filled primary action style; appended a `prefers-reduced-motion` guard.
- `src/lib/components/ReaderTabImpl.svelte` — toolbar hierarchy: "Back to Chat" demoted
  to subtle (nav), "Open File" promoted to primary CTA, empty-state "Open File" primary.
  (Import logic / parsing untouched.)
- `src/lib/components/ReaderImportSheet.svelte` — "Open In Reader" submit promoted to the
  primary CTA for clear hierarchy.
- `src/lib/components/QuickResourcesPanel.svelte` — rewritten as a lightweight launcher
  (see P2). Resize dock + collapse/expand behavior preserved.

## P1 — Reader typography / reading-column pass

- **Reading column**: centered `margin: 0 auto` prose column recalibrated to a calm,
  consistent width. Base / `width-medium` = **48rem (~768px)**, `width-narrow` = 38rem,
  `width-wide` = 56rem. The previous spread (42–66rem, up to ~1056px) drifted toward a
  work-surface width; it is now consistently a calm reading column. Line-height stays
  user-driven (1.35–2.30) and comfortable.
- **Token-driven colors**: surface/text/border/accent already token-driven via the
  `--reader-*` custom properties per theme (paper / sepia / night) — kept.
- **Mono micro-labels on metadata**: `reader-meta` chips now use a mono font stack,
  hairline `--reader-border` (no heavy pill fill), smaller tracking — reads as quiet
  metadata, not badges.
- **Toolbar hierarchy (primary vs secondary)**: three tiers now —
  - *primary* (accent-filled): "Open File" in toolbar + empty-state "Open File"
    (and import-sheet "Open In Reader");
  - *secondary* (hairline outline): Paste / Images / Prev-Next / Clear;
  - *subtle* (ghost): "Back to Chat" navigation + Fullscreen.
- **Hairline borders, one accent**: document card + meta chips use `--reader-border`;
  a single accent (`--reader-accent`) carries emphasis (blockquotes, links, primary CTA).
- **Reduced motion**: added a `@media (prefers-reduced-motion: reduce)` block that
  disables transforms/transitions on action buttons, image-nav, and the focus-return
  control.

## P2 — QuickResources IA cleanup (decision + changes)

**Decision taken**: QuickResources is no longer a second editor for notes/DMs. It is now
a **lightweight, single-purpose launcher** — a row of quick-link chips that open the
dedicated workspace panels (Notes, Messages, People, Media, Map, Transfers) via
`layoutStore.openRightPanel(id)`. This removes the muddied mental model flagged in
DESIGN_AUDIT §1/§2 (duplicate notes surface + three competing DM list UIs) while keeping
the ability to *reach* every resource in one click. The embedded `WorkspacePanelHost`
notes mode and the inline DM compose/quick-reply were removed — there is now ONE place
for notes (right-panel Notes) and ONE place for DMs (right-panel Messages).

**What changed**:
- Removed the `notes` / `dm` mode toggle, the in-panel DM channel select, the inline
  message list + compose, and all `socket`/DM helper logic.
- Added a token-driven launcher grid of `quick-link` chips (each links out via
  `openRightPanel`). The collapsed bar also shows icon-only launch buttons so users can
  still reach surfaces while collapsed.
- Kept the resize dock + collapse/expand (ambient-weight right-panel surface, untouched).
- Reduced-motion safe (hover/transform transitions guarded).

No behavior regression for "reach" use: every prior QuickResources destination is one
click away via the launcher.

## Verification

- `bun run check` → **0 errors, 75 warnings** (baseline was 75 warnings; not worsened).
- `bun run build` → **success** (built in ~19s, adapter-node, no errors).

## Remaining risks

- Users who previously *composed* a quick DM inline from QuickResources lose that inline
  composer; they now open the Messages panel to send. This is the intended IA fix
  (one place for DMs), but is a behavioral change for that narrow workflow.
- The launcher lists a fixed, curated set of panels (notes/dms/users/media/map/transfers)
  rather than reflecting runtime panel availability/permissions; if a panel is
  inaccessible to the current user it will still show but open to an empty/denied panel.
- Pre-existing 75 warnings are orthogonal to these changes (untouched components).
