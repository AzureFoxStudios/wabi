---
name: wabi-categories-implementation
description: "Implementation pattern for Wabi channel categories: adding ChannelKind::Category, position/parentId support, and type updates."
version: 1.1.0
author: Hermes Agent (based on 2026-07-28 implementation)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [implementation, wabi, rust, typescript, categories]
    related_skills: [writing-plans, subagent-driven-development]
---

# Wabi Categories Implementation Pattern

## Overview

This document captures the implementation pattern for adding channel categories to Wabi. The pattern emerged from Phase 0-2 of the categories feature implementation.

## Key Architecture Decisions

1. **Backend-first**: Add `ChannelKind::Category` to the domain model BEFORE touching the UI
2. **Reuse existing fields**: `position: i32` and `parent_id: Option<String>` already exist in the Channel struct but were dead/unused
3. **Append-only enum**: `ChannelKind` is `#[repr(u8)]` — never shift existing discriminants
4. **Single write path**: Use existing `channel_update` event, not a separate reorder event (for now)

## Implementation Flow

### Phase 1: Backend Domain Model

**File: `core/crates/wabidb/src/domain/mod.rs`**

1. Add new enum variants (append only):
```rust
pub enum ChannelKind {
    Text = 0,
    Voice = 1,
    // ... existing variants ...
    Gallery = 9,      // Was missing from enum despite being used
    Category = 10,    // NEW
}
```

2. Update test to verify discriminants:
```rust
#[test]
fn channel_kind_repr_is_u8() {
    assert_eq!(ChannelKind::Incident as u8, 8);
    assert_eq!(ChannelKind::Gallery as u8, 9);
    assert_eq!(ChannelKind::Category as u8, 10);  // NEW
}
```

**File: `core/crates/wabi-server/src/adapter/mod.rs`**

3. Add string mapping for new kinds:
```rust
let kind = match c.channel_kind {
    // ... existing arms ...
    wabidb::domain::ChannelKind::Gallery => "gallery",
    wabidb::domain::ChannelKind::Category => "category",
};
```

### Phase 2: Wire Format Extensions

**File: `packages/wabi-protocol/src/generated/ChannelType.ts`**

Add `"category"` to the union type:
```typescript
export type ChannelType = "text" | "voice" | ... | "gallery" | "category";
```

**File: `packages/wabi-protocol/src/generated/ChannelView.ts`**

Add position and parentId:
```typescript
export type ChannelView = {
    // ... existing fields ...
    position?: number | null,
    parentId?: string | null,
};
```

**File: `core/crates/wabi-server/src/socketio/shared.rs`**

Add to `row_to_channel_view`:
```rust
json!({
    // ... existing fields ...
    "position": row.get("position").and_then(|v| v.as_i64()).map(|v| v as i32),
    "parentId": row.get("parent_id").and_then(|v| v.as_str()),
})
```

### Phase 3: Position/Parent Writable

**File: `core/crates/wabi-server/src/socketio/wiring_handlers.rs`**

In `handle_update_channel_settings`:

1. Add to the `row` that goes to `channel_update_settings` event (for the min_role etc):
```rust
if let Some(pos) = settings.get("position").and_then(|v| v.as_i64()) {
    row.insert("position".to_string(), json!(pos as i32));
}
if let Some(parent) = settings.get("parentId").and_then(|v| v.as_str()) {
    row.insert("parent_id".to_string(), json!(parent));
}
if settings.get("parentId").and_then(|v| v.as_null()).is_some() {
    row.insert("parent_id".to_string(), json!(serde_json::Value::Null));
}
```

2. **CRITICAL**: Also add to the `patch` that goes to the channels projection (line ~268):
```rust
if let Some(pos) = settings.get("position").and_then(|v| v.as_i64()) {
    patch.insert("position".to_string(), json!(pos as i32));
}
if let Some(parent) = settings.get("parentId").and_then(|v| v.as_str()) {
    patch.insert("parent_id".to_string(), json!(parent));
}
if settings.get("parentId").and_then(|v| v.as_null()).is_some() {
    patch.insert("parent_id".to_string(), json!(serde_json::Value::Null));
}
```

**File: `core/crates/wabidb/src/projections/channels.rs`**

In `apply_updated`:
```rust
if let Some(pos) = patch.get("position").and_then(|v| v.as_i64()) {
    channel.position = pos as i32;
}
if let Some(parent) = patch.get("parent_id").and_then(|v| v.as_str()) {
    channel.parent_id = Some(parent.to_string());
}
if let Some(parent_null) = patch.get("parentId").and_then(|v| v.as_null()) {
    channel.parent_id = None;
}
```

### Phase 4: Frontend Types

**File: `frontend/src/lib/socket-types.ts`**

```typescript
type ChannelOptionalProtocolField =
  | ...existing fields...
  | 'position'
  | 'parentId';

export interface Channel extends Omit<ProtocolChannelView, ChannelOptionalProtocolField> {
  // ... existing fields ...
  position?: number;
  parentId?: string;
}
```

## Verification Commands

```bash
# Rust tests
cargo test -p wabidb --lib channel_kind_repr_is_u8

# Rust build
cargo check -p wabidb -p wabi-server

# TypeScript check
cd frontend && npm run check
```

## Common Pitfalls

1. **Missing match arms in adapter/mod.rs**: When adding new `ChannelKind` variants (Gallery, Category), you MUST add arms to the `match c.channel_kind` block in `adapter/mod.rs` (~line 849) AND in `channels.rs` `create_channel` (~line 125). Missing either causes `E0004: non-exhaustive patterns`. The `adapter/mod.rs` mapping is the one people forget — it serializes channel_kind for the wire format.
2. **serverUrl.ts port mismatch**: When frontend is served on `:3000` directly (no Docker port-forwarding), `serverUrl.ts` must NOT rewrite the backend port to `:3001`. The `port === '3000'` path and `ssr_default` path must return the same host:port as the frontend. A `:3001` hardcoded in these paths causes CORS failures on LAN access. Fix: ensure `serverUrl.ts` returns port 3000 for both local and LAN access when the server is on `:3000`.
2. **Type mismatch**: `position` is `i64` in JSON but `i32` in Rust — remember to cast
3. **Null vs missing**: `parentId: null` clears parent, missing field means "don't change"
4. **Field naming**: Rust uses `parent_id`, JSON uses `parentId` (camelCase)
5. **DOUBLE PATCH BUG**: Position/parentId must be added to BOTH the `row` AND the `patch` in handle_update_channel_settings. Missing from `patch` means the channels projection never receives the values!
6. **Test verification**: Always run the full test suite after adding enum variants, not just the specific test

## Key Learning from Implementation

## Key Learning from Implementation (updated 2026-07-28)

### Port Mismatch Bug: serverUrl.ts Hardcoded :3001 (CRITICAL PITFALL)

**Symptom**: wabi.chat at `100.87.255.66:3000` shows websocket disconnects and CORS failures despite the server being healthy on `:3000`. DevTools shows `Cross-Origin Request Blocked` for `:3001` endpoints that return `(null)` status.

**Root cause**: `frontend/src/lib/serverUrl.ts` has a `port === '3000'` code path (triggered when frontend is served directly on port 3000, no Docker port-forwarding) that incorrectly rewrites the backend URL to `:3001`. The `ssr_default` path also hardcodes `:3001`. When the server is on `:3000` and the frontend is on `:3000`, the frontend must not rewrite the port.

**Fix** (in `frontend/src/lib/serverUrl.ts`):
- `port === '3000'` case: return `${protocol}//${hostname}:3000` (was `:3001`)
- `ssr_default`: return `http://localhost:3000` (was `:3001`)

**Verification**: After restarting wabi-server, open `/api/setup/status` on the same port the frontend is served on. If the frontend is on `:3000`, the API must also be on `:3000`. CORS errors on `:3001` = serverUrl.ts is rewriting to the wrong port.

### Backend Port Convention

The wabi-server binary listens on port 3000 internally. The previous `:3001` in serverUrl.ts was a leftover from a Docker port-forwarding convention (host:3001 → container:3000). When serving directly (no Docker port mapping), the backend is on 3000. Do not remap the port in serverUrl.ts when both frontend and backend are on the same host.

### Frontend CSS Bug Pattern: Right Panel Flex Collapse

**Symptom**: Right panel tabs (Notes, Admin) don't scale horizontally — they end prematurely while Media/DM/Maps fill properly. Root cause: `.panel-stack-content` is `display: flex` and children without `flex: 1` size to `max-content`.

**Fix** (in `RightPanel.css`):
```css
.panel-stack-content > * { flex: 1; min-width: 0; min-height: 0; }
```

Note: use `> *` not `:global(*)` — RightPanel.css is a plain CSS file imported via JS, not a Svelte `<style>` block. `:global()` is invalid in plain CSS and throws at build (fixed before committing).

This is a reusable pattern for any SvelteKit right-panel dock where child panels must flex-fill their container.

### Frontend CSS Bug Pattern: Server Banner Overlay

**Symptom**: Server banner (set by admins/owners) not showing at top-left of server hub. A solid box covers the banner behind the Server Name/Icon. Root cause: The `::after` pseudo-element on `.top-section` used fully opaque hex tokens (`#1a1a2e`, `#24243e`) instead of intended translucent rgba values. The `.top-section:has(.banner-image)` selector was dead — no CSS rules were attached to it, so the banner was always fully covered.

**Fix** (in `sidebar-core-part1.css`): Replace opaque hex with rgba values and add `pointer-events: none` to the `::after` overlay. Add `:has(.banner-image)` rule with lighter alpha (0.35/0.55) for actual banner visibility.

### Resize Handle Discoverability

The right-panel resize handle (6-8px wide, transparent, visible only on hover) is present but easily missed. The `wabi:obvious-grab-rails` localStorage key can toggle amber labeled handles for discoverability testing. If resize seems broken, check if this key is set.

### Double Patch Bug applies to channels too

When implementing reorder, `position` must be sent in BOTH:
1. The `channel_update_settings` socket event (for the `handle_update_channel_settings` path)
2. The `channel_update` REST event (for the PATCH endpoint → projection path)

Missing from either path means position updates don't persist.
If you only add position/parentId to one but not the other, the values will appear to be set in the UI but won't actually persist. This was discovered during testing when channels appeared to reorder but reverted to original order after refresh.

## Reorganizable Channels (Discord-style drag-drop)

Building on the categories/position/parentId foundation, channels can be made fully reorganizable:

### Backend additions
### Frontend CSS Bug Patterns

### Frontend UI: Creating Category Folders from the Sidebar (2026-08-04)

**Goal**: Let users create new category folders (e.g. "sfw art", "nsfw art") directly from the ChannelSidebar, then drag channels into them.

**Changes needed**:

1. **`frontend/src/lib/channelStore.ts`** — Add `'category'` to `CreateableChannelType`:
   ```typescript
   export type CreateableChannelType = 'text' | 'voice' | 'forum' | 'gallery' | 'wiki' | 'stage' | 'lore' | 'planning' | 'category';
   ```

2. **`frontend/src/lib/components/sidebar/CreateChannelForm.svelte`** — Add category label + icon:
   ```typescript
   if (type === 'category') return 'Category';
   ```
   And add a `'folder-name'` icon class for category channels.

3. **`frontend/src/lib/components/ChannelSidebar.svelte`** — Three pieces:
   - **"Create Category" button**: A `section-category-btn` in the Text Channels section header (or a dedicated Categories header):
     ```svelte
     <button class="section-add-btn section-category-btn" class:active={showCreateInput && newChannelType === 'category'} on:click={openCreateFormForCategory} title="Create category" aria-label="Create category">
       <span class="plus-glyph">+</span>
     </button>
     ```
   - **Context menu item**: Add `{ id: 'create-category', label: 'Create Category', icon: 'archive', onSelect: openCreateFormForCategory }` to `buildChannelMenuItems()`.
   - **`groupByCategory` refactor**: Filter category channels by `type === 'category'` and treat them as parent nodes:
     ```typescript
     const categoryChannels = all.filter((c) => (c.type as string | undefined) === 'category');
     const categoryIds = new Set(categoryChannels.map((c) => c.id));
     // A channel belongs to a category when its parentId points to a category channel
     ```

4. **Category rendering** — Render each category as a collapsible row with folder icon + toggle:
   ```svelte
   {#each textCategoryMap.categories as cat (cat.id)}
     <div class="category-row">
       <button class="category-toggle" on:click={() => toggleCategory(cat.id)}>
         <svg class="category-folder-svg">...</svg>
         <span class="category-name">{cat.name}</span>
         <span class="category-count">{cat.channels.length}</span>
       </button>
       {#if !collapsedCategories.has(cat.id)}
         <div class="category-channels">
           <TextChannelList textChannels={cat.channels} ... />
         </div>
       {/if}
     </div>
   {/each}
   ```

**CSS** (`sidebar-channels.css`):
- `.category-row` — flex column, padding
- `.category-toggle` — full-width button, flex items center, gap
- `.category-folder-svg` — 16px icon, `--color-info` stroke
- `.category-name` — channel name text
- `.category-count` — muted count badge
- `.section-category-btn` — 24×24 button matching `.section-add-btn` styling

**Pitfall — category type must match backend**: When creating a category channel, the frontend sends `type: 'category'` to the server. The backend must have `ChannelKind::Category` (see Phase 1 above). If the backend doesn't recognize `'category'`, it will fall through to the default `Text` kind — the channel will be created but won't act as a category (no drag-drop nesting, no `parent_id` grouping). Always verify the backend `ChannelKind` enum includes `Category = 10` before shipping the frontend create button.

**Pitfall — don't weld text channels to a "Text Channels" header**: The old code treated channels with no `parentId` as "uncategorized". With categories, "uncategorized" channels should float freely (not inside a "Text Channels" folder). Only channels explicitly assigned to a category via `parentId` should be nested. The `groupByCategory` function must return `uncategorized` as a flat list, not a fake "Text Channels" category.

### Frontend CSS Bug Patterns
**Symptom**: Right panel tabs (Notes, Admin) don't scale horizontally — they end prematurely while Media/DM/Maps fill properly. Root cause: `.panel-stack-content` is `display: flex` and children without `flex: 1` size to `max-content`.

**Fix** (in `RightPanel.css`):
```css
.panel-stack-content > * { flex: 1; min-width: 0; min-height: 0; }
```

Note: use `> *` not `:global(*)` — RightPanel.css is a plain CSS file imported via JS, not a Svelte `<style>` block. `:global()` is invalid in plain CSS and throws at build.

### Server Banner Overlay Bug
**Symptom**: Server banner (set by admins/owners) not showing at top-left of server hub. A solid box covers the banner behind the Server Name/Icon. Root cause: The `::after` pseudo-element on `.top-section` used fully opaque hex tokens (`#1a1a2e`, `#24243e`) instead of intended translucent rgba values.

**Fix** (in `sidebar-core-part1.css`): Replace opaque hex with rgba values and add `pointer-events: none` to `::after`. Add `:has(.banner-image)` rule with lighter alpha for actual banner visibility.

### BusinessSurface.svelte Import Path
**Symptom**: `npm run build` fails with `Could not resolve "./businessPage.css"` from `BusinessSurface.svelte`. The file exists at `src/routes/business/businessPage.css` but the import uses a relative path that doesn't resolve.

**Fix**: Use `import '../../routes/business/businessPage.css'` (relative from `src/lib/components/business/` up to `src/` then down to `routes/`).
- `WdbAdapter::update_channel` in `adapter/mod.rs` — builds `channel_updated` event, including `position` in payload.
- `channel_to_response` — now returns actual `position`, `parent_id`, `description`.
- `list_channels` — sorts by `position` ascending.
- `serverUrl.ts` — when frontend is served on `:3000` directly, backend URL must be `:3000` not `:3001`. The `port === '3000'` path and `ssr_default` must not rewrite the port.
- **`WabiStore::update_channel`** trait method in `wabidb/src/engine/wabi_store.rs` — defaults to no-op in v1, full implementation emits the event.
- **`WdbAdapter::update_channel`** in `adapter/mod.rs` — builds the `channel_updated` event payload including `position`, delegates to `self.run()`.
- **`channel_updated` event payload** — `adapter/mod.rs` `("channel", "update")` arm now includes `position` and `parent_id` in the broadcast payload alongside name/description/force_spoiler.
- **`list_channels` sorting** — `wabi-server/src/api/channels.rs` `list_channels` sorts by `position` ascending before returning.
- **`channel_to_response`** — returns actual `position`, `parent_id`, `description` instead of hardcoded zeros/nones.

### Frontend additions
- **Drag-and-drop reorder** in `ChannelSidebar.svelte` — HTML5 drag-and-drop on channel items. On drop, calls PATCH API with new position.
- **Mixed channel types** — channels of any type (text, voice, forum, wiki, gallery, notes, dm) can be interleaved in any order. Position is a global integer; type groupings are visual only.

### The DOUBLE PATCH BUG applies here too
When implementing reorder, the `position` field must be sent in BOTH:
1. The `channel_update_settings` socket event (for the `handle_update_channel_settings` path)
2. The `channel_update` REST event (for the PATCH endpoint → projection path)

Missing from either path means position updates don't persist.

## Unified Sidebar List — folders hold ANY type (2026-08-06)

**The "cold binary" trap**: `ChannelSidebar.svelte` had a `sameChannelFamily()` gate in the drag logic that **actively refused cross-type drops** (`text≠voice≠gallery…` — it returned `false` for any type mix, and `handleChannelDrop`/`sectionOf` enforced it). This is the real mechanism behind "text goes to text channel": even though the backend persists `parentId`+`position` for EVERY channel type (via `reorder-channels` socket → `update_settings`+`update` events), the frontend blocked mixing. **Any claim that "channels of any type can be interleaved" is false until `sameChannelFamily` is relaxed.**

### The fix (two parts)

1. **Relax the gate** — `sameChannelFamily()` must `return true` (it is called in `handleChannelDragOver`, `handleChannelDrop`, `sectionOf`, and `moveChannelToCategory`; all of those then allow cross-type drops naturally).

2. **One pool, one grouping** — the sidebar previously ran SEVEN type-siloed sections (text/voice/gallery/forum/wiki/lore/planning), each with its OWN `groupByCategory(...)` call and its OWN list component. Replace with:
   ```typescript
   $: unifiedSidebarChannels = [...textChannelsAll, ...groupChannels, ...voiceChannels,
     ...galleryChannelsAll, ...forumChannelsAll, ...wikiChannelsAll, ...loreChannelsAll,
     ...planningChannelsAll].filter(ch => (ch.type as string | undefined) !== 'category');
   $: unifiedCategoryMap = groupByCategory(unifiedSidebarChannels, $channels);
   ```
   Render ONE "Channels" section: `{#each unifiedCategoryMap.categories}` folder rows + one uncategorized list. Folders now hold any mix.

3. **`UnifiedChannelList.svelte`** — a single mixed-type row renderer (`frontend/src/lib/components/sidebar/UnifiedChannelList.svelte`). Each row picks icon by type (hash/speaker/gallery/forum/wiki/lore/planning/group) and click behavior (voice → `onVoiceChannelClick` joins the call; everything else → `onChannelButtonClick` opens the channel). It MUST preserve the full voice row (occupancy count, follow/whiteboard buttons, REC tag, connected state, member list with speaking/duration, breakout rooms) and thread nesting (`threadChannelsByParent`) or those features silently disappear when the old per-type lists are removed. Port the voice helpers from `VoiceChannelList.svelte` verbatim (they read stores directly: `voiceChannelMembers`, `speakingUsers`, `isLocalSpeaking`, `voiceCallRecordingParticipants`).

### Pitfall — category chevron CSS selector

Folder chevrons showing a dead ">" that never rotates: the CSS rule targeted `.category-row[aria-expanded="false"]` but `aria-expanded` lives on the INNER `.category-toggle` button, so the selector never matched. Fix (matches the `.section-toggle` pattern — chevron SVG `M9 6l6 6-6 6` points right by default, rotate 90deg when OPEN):
```css
.category-toggle[aria-expanded="true"] .category-chevron { transform: rotate(90deg); }
```

## Pitfall — serde alias + dual-key send = bare 422 on create (2026-08-21)

**Symptom**: "Failed to create channel: 422" ONLY when placing a channel into a folder; plain create works.

**Cause**: frontend `api/channels.ts` sent BOTH `parent_id` and `parentId`; backend used `#[serde(default, alias = "parentId")] parent_id`. Serde treats alias+canonical as ONE field — receiving both = "duplicate field" error → axum Json extractor rejects with bare 422 BEFORE the handler runs. `AppError` has no 422 variant, so any unexplained 422 = extractor rejection, not handler logic. Introduced in 573ddee (alias and dual-send landed in the same commit — feature was born broken).

**Fix pattern**: never combine `alias` with a client that sends both spellings. Either flatten-compat struct (`#[serde(flatten)] parent: Compat { parent_id, #[serde(rename="parentId")] camel }`) + merge accessor, or single key on the wire. Regression test must POST/parse the both-keys body. Fixed in 4342285.

**E2E proof method**: run old binary vs new binary against scratch data dirs and curl the exact old body — old 422 / new 200 with `parent_id` set is the A/B that proves it. Note: register returns `token`, login returns `accessToken` (peer changed AuthResponse mid-session).

### Pitfall — later commits re-introduce fixed bugs

Feature commits that land AFTER a fix can silently re-add the exact bug (2026-08-06: `2b5a3b1` handoff A–F re-added the sunburst gear in `UserPopoutActions.svelte` AND re-added the forum `SurfaceToolbar` pills after both were fixed). When the user says "the work was poofed / still broken": (1) `git merge-base --is-ancestor <your-commit> HEAD` to confirm the commit is on main, (2) grep the CURRENT source for the fix marker (path data, class name) — git log top does not prove current state.

### Pitfall — folders don't stick after refresh (parentId on init)

**Symptom**: Drag channel into a category folder works until hard refresh / reconnect — then everything is uncategorized again.

**Root cause (2026-08-07)**: `WdbAdapter::get_channels_raw` (used by socket `init`) wrote category `parent_id` into **`parent_channel_id`** and omitted **`position`**. `row_to_channel_view` maps:
- `parent_id` → wire `parentId` (folder nesting)
- `parent_channel_id` → wire `parentChannelId` (threads/breakouts)

So init never sent `parentId` / `position` for folder membership. Optimistic UI looked correct; refresh lost it.

**Fix**:
1. `get_channels_raw` must emit `position` + `parent_id`/`parentId` (NOT `parent_channel_id` for category parent).
2. FE `normalizeChannel` must accept `parentId`/`parent_id` and keep `parentChannelId` separate.
3. `channels-reordered` broadcast must always include `parentId` (including JSON `null` to clear).

### Folder reorder

Category rows are first-class channels (`type === 'category'`). Drag folder headers to reorder via the same `reorder-channels` path with `parentId: null` and sequential `position`. Dropping a non-category channel on a folder header/body nests it (`parentId = catId`).