# Wabi Component Fracture Plan
## Document Version: 1.0
## Purpose: Track exact fracture lines for God-component decomposition

---

## Philosophy

Extract along natural UI boundaries (tabs, panels, modals) rather than arbitrary line counts. Each extracted component owns its own state, handlers, and lifecycle. The parent shell keeps only shared state (current tab, open/close) and passes data via props.

---

## Phase 1: Settings.svelte (8,033 lines → ~400 lines)

### Current Structure
- **Script block:** lines 1-4176 (4,176 lines of TypeScript)
- **Markup block:** lines 4177-8033 (3,857 lines of HTML/Svelte)
- **Style block:** NONE (all styles in external CSS: `settings-*.css`)
- **Tab switch:** `{#if activeSettingsTab === 'xxx'}` starting at line 4243

### Tab Bodies (markup only)
| Tab | Start Line | ~End Line | ~Lines | Notes |
|-----|-----------|----------|--------|-------|
| profile | 4243 | 4451 | 208 | Avatar, banner, username, bio |
| audio | 4452 | 4864 | 412 | Sound effects, ringtone, spatial audio, mic test |
| notifications | 4865 | 5238 | 373 | Desktop notifs, mentions, previews |
| accessibility | 5239 | 5400 | 161 | Interface scale, color assist, reduced motion |
| appearance | 5401 | 5695 | 294 | Themes, chat density, avatars, animation |
| server | 5696 | 5742 | 46 | Directions assist, upload limits |
| addons | 5743 | 7128 | 1385 | Addon import/export, manifest, runtime toggle |
| emojis | 7129 | 7295 | 166 | Custom emoji upload grid |
| storage | 7296 | 7300 | 4 | Already wraps `<StorageSettings />` — thin |
| admin | 7301 | 7916 | 615 | User roles, donation config, relay nodes, password reset |
| about | 7917 | ~8030 | ~113 | Version, credits, links |

### Extracted Components (new files)

All go into `src/lib/components/settings/`:

```
settings/
├── SettingsShell.svelte          (renamed from Settings.svelte, ~400 lines)
├── ProfileSettingsTab.svelte   (~300 lines script + markup)
├── AudioSettingsTab.svelte     (~500 lines)
├── NotificationSettingsTab.svelte (~400 lines)
├── AccessibilitySettingsTab.svelte (~250 lines)
├── AppearanceSettingsTab.svelte (~400 lines)
├── ServerSettingsTab.svelte    (~150 lines)
├── AddonSettingsTab.svelte     (~1500 lines — largest)
├── EmojiSettingsTab.svelte     (~250 lines)
├── AdminSettingsTab.svelte     (~800 lines)
└── AboutSettingsTab.svelte     (~150 lines)
```

### Shared State Strategy

**Props down from SettingsShell:**
- `currentUser` (already from store, each tab reads directly)
- `isOpen` (for modal animation binding)
- `dispatch` (for events like 'close')

**Tab-specific state moves INTO the tab component:**
- Audio: all `let micTest...`, `let audioInputDevices`, ringtone presets
- Notifications: `let notificationSound`, `let notificationVolume`
- Appearance: `let interfaceScale`, `let colorAssistEnabled`, theme prefs
- Admin: `let uploadLimits`, `let donationConfig`, `let relayRoster`

**State that stays in SettingsShell (shared across tabs or needed for shell):**
- `activeSettingsTab` (the tab switcher state)
- `isOpen`, `requestedPaymentSurface`, `requestedPasswordChangeRequest`
- Functions that dispatch events to parent (on:close)
- `saveUserSettings()` / generic save (if truly shared)

### Import Chain Fix

SettingsShell currently imports directly:
- `StorageSettings` (already extracted, keep)
- `ConfirmDialog` (keep in shell)
- `PaymentConnectionsModal`, `PaymentHistoryModal`, `ServerDonationModal` (keep in shell — they're overlay modals)
- `PaymentSheet` (keep in shell)
- `AvatarEditor` (move into ProfileSettingsTab)
- `ThemeCustomizer`, `UsernameFontCustomizer`, `UniformFontMode` (move into AppearanceSettingsTab)

---

## Phase 2: ChannelSidebar.svelte (2,026 lines → ~400 lines)

### Current Structure
- **Script:** 1,012 lines
- **Markup:** 1,014 lines
- **Style:** NONE (styles in `sidebar-*.css`)

### Natural Fracture Lines

1. **ChannelSettingsModal** (~500 lines)
   - Modal for editing channel name, topic, NSFW, slowmode, voice capacity
   - Currently inline starting around line 1350 (approx)

2. **VoiceChannelPanel** (~300 lines)
   - Voice channel member list, join/leave buttons, recording tag

3. **ThreadList** (~250 lines)
   - Thread buttons under each channel

4. **ServerBannerSection** (~150 lines)
   - The `.top-section` with banner image, server name, settings gear

5. **ChannelTree** (~400 lines)
   - The main channel list with categories, chevrons, unread badges

6. **ChannelContextMenu** (~200 lines)
   - Right-click menu generation logic (already somewhat isolated in `buildContextMenuItems`)

### Extracted Components

```
lib/components/
├── ChannelSidebar.svelte          (shell: top-section + tree + expand-btn)
├── settings/                      (from Phase 1)
└── sidebar/
    ├── ChannelTree.svelte
    ├── ChannelTreeItem.svelte
    ├── ThreadList.svelte
    ├── VoiceChannelPanel.svelte
    ├── ServerBannerSection.svelte
    └── ChannelSettingsModal.svelte
```

---

## Phase 3: CSS Consolidation

### Current State
- 48 CSS files in `styles/components/` (added server-switcher.css)
- 6 `sidebar-*.css` files (core, channels, compact, mobile, profile)
- 8 `settings-*.css` files (core, shell, nav, profile, appearance, about, misc, mobile)
- 12 `ml-*.css` files (MessageList sub-modules)
- 8 `chat-*.css` files
- 1 `server-switcher.css` (extracted from ServerSwitcherPanel.svelte)

### Audit Criteria
- Merge files < 150 lines into their parent category file
- Keep splits only if they represent truly independent concerns (mobile.css stays separate for responsive)
- Remove `.backup` files (channelsidebar.css.backup, messagelist.css.backup, etc.)

---

## Phase 5: ServerSwitcherPanel + MessageList (COMPLETED)

### ServerSwitcherPanel.svelte (1,921 → 1,020 lines)

- **Extracted:** 901-line `<style>` block → `styles/components/server-switcher.css` (905 lines)
- **Import added to:** `styles/styles.css`
- **Result:** Component is now script + markup only (651 lines script, 369 lines markup)

### MessageList.svelte (3,334 → 2,381 lines)

Extracted 13 new files across 3 levels:

**Top-level components:**
| Component | Lines | Purpose |
|-----------|-------|---------|
| `MessageItem.svelte` | 7 | Thin wrapper → MessageItemContent |
| `MessageItemContent.svelte` | 309 | Shell: message div, avatar, header, body, reactions |
| `ImageLightbox.svelte` | 259 | Enlarged image modal with zoom/gallery/toolbar |
| `VideoLightbox.svelte` | 44 | Enlarged video modal |

**`message/` sub-components:**
| Component | Lines | Purpose |
|-----------|-------|---------|
| `MessageHeader.svelte` | 100 | Username, role badge, staff tag, timestamp, badges |
| `MessageContent.svelte` | 262 | Content-type switch (directions, albums, role gate, gif, emoji, files, markdown) |
| `MessageFileContent.svelte` | 408 | File rendering (multi-gallery, single file: model/image/video/audio/blend/other) |
| `MessageLinkEmbeds.svelte` | 86 | Embedded media URLs (YouTube, Spotify, images, videos, audio, models, link previews) |
| `MessageItemActions.svelte` | 63 | Quick reactions strip + action buttons |
| `MessageReplyPreview.svelte` | 44 | Reply preview with jump-to |
| `MessageReactions.svelte` | 61 | Reaction buttons with emoji + count |
| `MessageEditForm.svelte` | 28 | Edit mode textarea + save/cancel |
| `MessagePersistenceRow.svelte` | 31 | Persistence failed/retrying badge + retry button |

**Shared utilities:**
| File | Lines | Purpose |
|------|-------|---------|
| `messageItemUtils.ts` | 126 | Pure functions: file type detection, URL parsing, album/directions parsing |
| `messageItemAnimation.ts` | 48 | Transition functions and easing curves |

---

## Phase 4: Other God Components (future)

| Component | Lines | Primary Bloat |
|-----------|-------|---------------|
| ~~MessageList.svelte~~ | ~~3,334~~ | ~~Script (2,206 lines) — DONE (Phase 5)~~ |
| CallModal.svelte | 1,983 | Style (919 lines) + modal shell markup |
| ~~ServerSwitcherPanel.svelte~~ | ~~1,921~~ | ~~Style (901 lines) — DONE (Phase 5)~~ |
| MainLayout.svelte | 1,706 | Even split script/style — dock panel extraction |
| ProjectsView.svelte | 1,870 | Style (~950 lines) — move CSS to external |
| MediaAlbumsTab.svelte | 2,819 | Likely markup-heavy — album grid logic |
| MapWorkspace.svelte | 2,493 | Map rendering + UI mixed |

---

## File Naming Conventions

- Tab components: `{Feature}{Noun}Tab.svelte` or `{Feature}SettingsTab.svelte`
- Panel components: `{Feature}Panel.svelte`
- Modal components: `{Feature}Modal.svelte`
- List components: `{Feature}List.svelte` or `{Feature}Tree.svelte`
- Sub-directories match the parent component name: `settings/`, `sidebar/`, `chat/`

---

## State Passing Patterns

1. **Svelte stores:** Tabs read `currentUser`, `channels`, etc. directly from stores. No prop drilling needed for global state.
2. **Props:** Shell passes `isOpen`, `onClose`, `activeTab` to tabs.
3. **Events:** Tabs dispatch `save`, `close`, `error` to shell. Shell dispatches to parent.
4. **Context:** Only for deeply nested shared state (rarely needed).

---

## Verification Checklist Per Phase

- [ ] Extracted component compiles without errors
- [ ] Shell component compiles without errors
- [ ] All imports updated in shell
- [ ] No broken references to moved functions/state
- [ ] Tab switching still works
- [ ] All tab functionality preserved (save, load, toggle)
- [ ] No visual regressions (styles still load)
- [ ] Modal overlays (ConfirmDialog, PaymentSheet) still work from shell
- [ ] Backup of original file created before deletion

---

## Order of Execution

1. **Create `settings/` directory**
2. **Extract SettingsShell.svelte** (thin wrapper, keep all imports)
3. **Extract ProfileSettingsTab.svelte** (smallest, proof of concept)
4. **Extract StorageSettingsTab.svelte** (already thin, just wrapper)
5. **Extract AboutSettingsTab.svelte** (small, safe)
6. **Extract AccessibilitySettingsTab.svelte**
7. **Extract AppearanceSettingsTab.svelte**
8. **Extract ServerSettingsTab.svelte**
9. **Extract EmojiSettingsTab.svelte**
10. **Extract NotificationSettingsTab.svelte**
11. **Extract AudioSettingsTab.svelte**
12. **Extract AdminSettingsTab.svelte** (complex, last)
13. **Extract AddonSettingsTab.svelte** (largest, last)
14. **Delete old Settings.svelte**, rename SettingsShell → Settings.svelte
15. **Verify build**
16. **Move to Phase 2: ChannelSidebar**
