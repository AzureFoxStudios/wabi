You are implementing P1 (Toolbar restructure) of the Reader Design TLC plan for Wabi.

## Context
Reader is a full workspace view (addon tab `READER_ADDON_ID`). A `WorkspaceViewBar` component is now mounted above Reader in MainLayout — it provides the pill navigation (Messages/Reader/3D/Map/etc) and a "Messages" return button. The old "← Back to Chat" button inside Reader is now redundant.

## Files you MAY modify
- `frontend/src/lib/components/ReaderTabImpl.svelte`
- `frontend/src/styles/components/reader-tab.css`

## Files you MUST NOT touch
- `readerWorkspace.ts`, `readerTabHelpers.ts`, `ReaderImportSheet.svelte`, `Chat.svelte`, `MainLayout.svelte`, `ChatHeader.svelte`, `WorkspaceViewBar.svelte`, or any other files outside the two above.

## P1 Changes — implement all:

### 1. Remove "← Back to Chat" button
Delete the redundant "← Back to Chat" button from the Reader toolbar (currently line ~295: `mobileTabQueue.closeAddonTab(READER_ADDON_ID)`). WorkspaceViewBar in MainLayout already provides this escape.

### 2. Slim toolbar to icon-only essentials when doc is open
When `$readerSelection` exists, the toolbar right side should show ONLY:
- Prev/Next as icon-only chevron buttons (SVG ↑↓ or ←→) with the page indicator between them
- Font size as −/+ icon buttons (not a slider in the toolbar — that moves to settings panel)
- Theme cycle as an icon button (cycles paper→sepia→night→paper on click)
- Fullscreen toggle icon button
- A gear icon button that opens the collapsible settings panel (see #7)

### 3. Move import cluster to empty state only
When NO document is selected (`!$readerSelection`), show import buttons (Open File, Images, Paste Markdown, Paste Text) in the toolbar. When a document IS open, these buttons are GONE from the toolbar entirely. The import buttons should only appear in the empty state area.

### 4. Move title + meta into article header
The document title, word count, min read, progress %, and source should appear as a subtle header INSIDE the article viewport (above `.reader-document`), not in the toolbar. Create a new `.reader-article-header` element inside `.reader-document-viewport` that shows this info. The toolbar should NOT contain the title group anymore.

### 5. Add reading progress bar
A thin (2-3px) accent-colored progress bar at the top of `.reader-shell`, showing `readerProgressPercent`. Use CSS `width: {readerProgressPercent}%` on a bar element. It should be visible above the toolbar or integrated into the toolbar top edge.

### 6. Enhance focus mode
- Keep existing `readerChromeHidden` pattern
- Add a keyboard shortcut: pressing `f` (when not in an input) toggles focus mode
- Style the `reader-focus-return` button to match app pill aesthetic (rounded, glass-like, with icon)
- Add a focus/focus-exit icon button to the slimmed toolbar

### 7. Secondary row → collapsible settings panel
The secondary row (Recent, Theme, Font, Width, Fit, Dir, Size slider, Line Height slider) becomes a collapsible panel. Clicking a gear icon in the toolbar toggles this panel open/closed. The panel slides down from the toolbar. Default state: collapsed.

### 8. Update CSS
- `.reader-toolbar` should be much slimmer (single row, ~40-48px height)
- `.reader-article-header` styles for the in-content title/meta
- `.reader-settings-panel` styles for the collapsible panel
- Progress bar styles
- Icon button styles (match existing `.reader-action-btn` but smaller, icon-only)
- Enhanced `.reader-focus-return` pill styling

## Svelte 5 rules
- Use `$props()`, `$derived`, `$effect` — no `export let`, no `$:`
- Use `on:click` for event handlers
- Match existing project conventions

## Verification (run after changes)
```bash
cd /var/home/Ronin/wabi/frontend && npx svelte-check --tsconfig tsconfig.json
STATIC_BUILD=1 bun run build
```
Do NOT commit. Do NOT write a report file.