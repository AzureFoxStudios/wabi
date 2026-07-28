# Card N2 — External Note App Integration

**Created:** 2026-07-28
**Status:** IN PROGRESS
**Kanban:** TODO

---

## Summary

Add support for connecting external note-taking apps (Obsidian, Notion, Logseq, generic URL) in the Notes tab of DmHub. Users can configure a preferred app and click to open notes in it. No syncing — just shortcuts.

---

## What needs to happen

### 1. Add external app config to DmHub Notes tab

Add a settings area to NotesView (or a separate config section in DmHub) where users can:
- Select an external app type (Obsidian, Notion, Logseq, Custom URL)
- Enter the app's URI/scheme or URL
- Test the connection (opens the app/URL)

### 2. Wire the integration into NotesView

When a note is linked to an external app, clicking it should open the external app with the note content (or the app itself).

### 3. Store config in localStorage

Use notesStore patterns (`safeRead`/`safeWrite`) to persist the external app config per user.

## DO NOT touch
- notesStore.ts core functions — consume them, don't refactor
- DmHub.svelte overall structure — only add the Notes integration
- Any backend/Rust code

## Verification
- bun run check: 0 errors
- DmHub renders Notes tab with external app config
- Config persists across page reloads
- External app link opens correctly
