# Right Panel DM Audit Notes

Audited files (May 11 2026):
- frontend/src/lib/components/WorkspacePanelHost.svelte (42 lines)
- frontend/src/lib/workspacePanels.ts (285 lines)
- frontend/src/lib/components/DMTab.svelte (1363 lines)
- frontend/src/lib/components/DMMessageView.svelte (1436 lines)
- frontend/src/lib/layoutStore.ts (838 lines)
- frontend/src/lib/dmPrivacyMode.ts (50 lines)

## File Sizes
| File | Lines | Role |
|------|-------|------|
| DMTab.svelte | 1363 | Tab UI + DM list + conversation selection + header actions + context menus + group settings + new DM panel |
| DMMessageView.svelte | 1436 | Messages display + composer + mention system + directions cards + payments + notes + line DM addon themes |

## Category A: Inline Bloat (inline code that should be a component)

**A1. Inline composer in DMMessageView.svelte (lines 686-729)**
- textarea with auto-resize, character counter, unicode emoji preview, send button
- Keyboard handling (Enter/send, Shift+Enter newlines, mention navigation)
- Does not use a shared MessageComposer or ChatInput component
- ~60 lines of composer markup duplicated effort relative to any channel composer

**A2. Directions card rendering in DMMessageView.svelte (lines 600-673)**
- Full "Local Directions" card with: place label, POI, layer, building, floor, coordinates, origin coordinates
- 4 buttons: Mini Map, Full Map, Smart Open, Open OSM
- Inline, special-purpose HTML; should be a DirectionsCard.svelte component

**A3. Mention suggestion popup in DMMessageView.svelte (lines 687-705)**
- Suggestion list markup + selected state + kind labels
- Duplicated anywhere else with @-mentions?

**A4. Inline SVG icons (both files)**
- DMTab: voice call icon, video call icon, trash icon, back arrow, 3-dot menu, group icon, privacy warning icon, inline action icons, close icon
- DMMessageView: send arrow, map icon, pay icon, cash icon, notes icon, close icon, encrypted lock icon, directions icons
- Pattern: each SVG is ~8-20 lines of path data inlined at point of use

**A5. Retention control in DMMessageView header (lines 529-537)**
- <label><select> for message retention inside the message view header

**A6. Privacy mode UI in DMTab active header (lines 482-491)**
- Open-mode warning pill with inline SVG icon in DM header title area

## Category B: Logic Bloat (script block doing too much)

**B1. DMTab.svelte script block: conversation list management + call routing + context menu builder + header action builder**
- Lines 34-466 (432 lines of script) handle:
  - DM list filtering, sorting (by pin + timestamp)
  - Inline action generation for every row (`buildConversationActions`, `getInlineActions`)
  - Context menu builder (`buildContextMenuItems`)
  - Header action menu builder (`buildHeaderActionMenuItems`)
  - Privacy mode confirmation dialog + setter
  - Call start functions (DM quick call, group quick call) with stable ID resolution
  - ResizeObserver on header for compact action mode toggle

**B2. DMMessageView.svelte script block: composer engine + mention system + payment launch + retention + entity manager**
- Lines 1-482 handle:
  - Message send with: command parsing (/directions), emoji shortcode replacement, write-upper-case, entity reconciliation, chunk/split logic, place entity building
  - Mention suggestion engine: user + place queries, token tracking, cursor math
  - Payment launch detection from store
  - Line DM addon profile resolution
  - Character counter with warn threshold
  - Retention change handler
  - Directions card detection

**B3. DM list sorting computed in Svelte reactive block (DMTab lines 66-75)**
- Sorts by pin status first, then by last message timestamp
- Runs on every `$channelMessages` store update for every DM channel
- Reasonable but note the O(n log n) + pinned set construction on every message event

## Category C: Render Duplication / Branching

**C1. Conversation item rendered twice (DMTab lines 605-653 and 655-718)**
- #{if channel.type === 'group'} ... {:else} ... {/if} with near-identical row markup
- Group path has: GroupAvatar, member count text, group name
- DM path has: user avatar, status dot/privacy badge, username, last preview
- Both paths include: pin badge, timestamp, hover actions (voice/video/delete)

**C2. Inline action buttons duplicated: list row actions vs header actions**
- List row: `getInlineActions(channel, other)` rendered inside conversation row
- Active header: `headerActions` / `headerCallActions` / `headerRemoveAction` computed separately
- Same action definitions rebuilt in two places

**C3. Action definitions rebuilt on every reactive cycle**
- `buildConversationActions` is called per row in list rendering AND for context menus AND for header menus
- Could be memoized per channel

## Category D: Missing Abstractions

**D1. No shared MessageComposer component**
- DM composer shares patterns with channel composer but is fully inline
- Auto-resize, char counter, emoji preview, send handling would naturally be a shared component

**D2. No shared ConversationHeader component**
- DMTab active header (lines 472-531) mixes back button, title with privacy pill, call buttons, settings/delete buttons, compact-vs-inline layout, ResizeObserver
- Should be a standalone DMConversationHeader with its own state

**D3. No shared ConversationListItem component**
- Group and DM row rendering should share a base shell with type-specific children

**D4. Privacy mode UI scattered between DMTab header pill and context menu**
- Header shows "Open" pill as a warning badge
- Context menu shows full privacy switcher (Sealed / Private / Open)
- Logic in DMTab; store in dmPrivacyMode.ts. UI fragments split across locations.

## Category E: CSS Bloat

**E1. DMTab has ~606 lines of <style>** (lines 756-1363)
- Large because it handles: active header, list view, new DM panel, search, conversation rows, inline actions, context menus, status dots, pinned styling, empty state, responsive media query

**E2. DMMessageView has ~666 lines of <style>** (lines 770-1436)
- Handles: addon themes, wallpaper/scrim layers, bubble styling, directions card, composer area, mention suggestions, char counter, send button, notes panel, 3 addon preset overrides (line, discord, minimal), responsive breakpoints

## Category F: Cross-Panel Coupling

**F1. DMTab dispatches `openSettings` for payments (line 25)**
- Tunnels `paymentSurface: 'connections'` up through WorkspacePanelHost to Chat.svelte or wherever settings modal lives
- Couples a right panel to global settings routing

**F2. DMMessageView imports payment modals directly (lines 8, 10, 133-152)**
- ManualCashModal and PaymentSheet imported + opened directly in message view
- Payment launch logic (`pendingConversationPaymentLaunch`) reads a store and auto-opens modals

**F3. DMMessageView opens maps in-line (line 540-545)**
- Calls `openPreferredMapSurface()` and `openMapPanel()` directly from a header button
- Tightly couples messaging to map workspace

## Quick Wins (smallest effort, biggest cleanup)

1. **Extract DirectionsCard component** from DMMessageView (A2)
2. **Extract DMConversationHeader component** from DMTab (D2) - header with back, title, privacy pill, actions
3. **Extract ConversationListItem component** from DMTab (D3) - group + DM variants
4. **Move privacy mode context menu into its own sub-component or simplified structure**
5. **Inline SVGs: consider using a shared Icon component** (feather icons already used elsewhere; are these custom?)
