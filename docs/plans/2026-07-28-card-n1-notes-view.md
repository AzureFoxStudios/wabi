# Card N1 — Notes View + External Note App Integration

**Created:** 2026-07-28
**Status:** RESEARCH
**Kanban:** TODO

---

## Summary

Add a "Notes" icon/tab at the top of the channel list (left rail) that opens a Notes view. The view should let users see their local notes and optionally connect to an external note-taking app (Obsidian, Notion, etc.) via a configurable sync/link mechanism.

---

## Context

Wabi already has a local notes system:
- `frontend/src/lib/notesStore.ts` — IndexedDB-backed local note storage (create, read, write, sort, pin)
- `frontend/src/lib/userNotes.ts` — per-user notes storage key (`wabi.userNotes.byUserId`)
- `frontend/src/lib/components/NotesWorkspace.svelte` — full notes workspace UI (776 lines)
- `frontend/src/lib/components/NotesDmDock.svelte` — bottom dock with Notes + DMs tabs (244 lines)
- `frontend/src/lib/components/QuickScratchpad.svelte` — quick note entry (uses notesStore)

What does NOT exist yet:
- A Notes icon/tab in the channel sidebar (top of the left rail)
- A "Connect to external note app" option (Obsidian, Notion, etc.)
- A Notes view in the main workspace area (distinct from the dock)

---

## What needs to happen

### 1. Add Notes icon to channel list

The channel list (`ChannelSidebar.svelte`) currently has icons for channels, DMs, and server settings. A Notes icon needs to be added as a persistent entry at the top (or bottom) of the list.

**Design decision needed:** Top or bottom of the list? Top aligns with "core feature" treatment. Bottom keeps it below all channels (less prominent). Recommendation: top, next to the server name/logo.

**Acceptance criteria:**
- Notes icon visible in channel sidebar
- Clicking it opens NotesView in the main content area
- Icon uses a consistent visual style with other sidebar icons

### 2. Build NotesView component

A new `NotesView.svelte` (or reuse/reformat `NotesWorkspace.svelte`) that renders in the main content area when the Notes icon is clicked.

**Acceptance criteria:**
- Shows list of local notes (title, snippet, updated time)
- Create/edit/delete notes inline
- Pin important notes
- Color-coding (reuse `NOTE_COLORS` from notesStore)

### 3. External note app integration

Add a settings/option to connect to an external note-taking app. This is NOT about syncing all notes — it's about a "quick link" that opens the user's preferred app.

**Supported apps (initial):**
- Obsidian (local vault — file:// URL or Obsidian URI scheme `obsidian://`)
- Notion (via Notion URL or integration)
- Logseq (local app URI)
- Generic "Open a URL" option for any app

**Acceptance criteria:**
- Settings page has a "Notes" section with external app config
- A "Connect" button per app type
- Once connected, a link/button in NotesView opens the external app
- No data is synced by default — just a shortcut/link

### 4. Wire Notes into the layout

Update `+layout.svelte` or `MainLayout.svelte` to render `NotesView` when the Notes tab is active in the main content area.

**Acceptance criteria:**
- NotesView renders in the workspace when active
- Back button / close returns to previous view
- Does not break existing DmHub/right panel flow

---

## Key files to touch

| File | What |
|------|------|
| `frontend/src/lib/components/ChannelSidebar.svelte` | Add Notes icon button to sidebar |
| `frontend/src/lib/components/NotesWorkspace.svelte` | Reuse/adapt for NotesView |
| `frontend/src/lib/components/NotesView.svelte` | New: main notes view component (or refactor NotesWorkspace) |
| `frontend/src/lib/notesStore.ts` | Add any new API surface needed |
| `frontend/src/routes/+layout.svelte` or `MainLayout.svelte` | Wire NotesView into layout |
| `frontend/src/lib/components/settings/` | Add Notes settings section |
| `frontend/src/lib/socket-types.ts` | Add Notes-related types if needed |

---

## DO NOT touch

- `notesStore.ts` core functions (readNotes, writeNotes, createEmptyNote, sortNotesWithPin) — do not refactor, just consume
- `DmHub.svelte` — leave as-is
- `NotesDmDock.svelte` — leave as-is (the dock continues to work independently)
- Any backend/Rust code — notes are local-first, no server changes needed

---

## Open questions

1. Should the Notes icon be a "pin" icon or something else? Existing icon set in the project uses Heroicons or similar.
2. Should external app integration use URI schemes (`obsidian://`, `file://`) or just open a URL?
3. Should the Notes icon go at top or bottom of the sidebar?
4. NotesView — new component or refactor existing NotesWorkspace.svelte? (Recommendation: create NotesView that wraps/reuses notesStore, keep NotesWorkspace for the dock.)

## Linked roadmap

See `docs/ROADMAP.md` for full project roadmap and priority ordering.
