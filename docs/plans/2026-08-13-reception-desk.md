# Reception Desk Implementation Plan

> **For Hermes / OpenCode:** implement this plan task-by-task. Hermes reviews later. Do not invent a second sidebar, a join-gate, or staff-role self-assignment.

**Goal:** Give every server a reopenable `#reception` room whose board lets a person pick interest roles and which rooms sit in *their* channel list.

**Architecture:** Reception is a first-class channel kind, not a settings page and not a Discord “Channels & Roles” tab. The board lives *inside* that channel. Default rooms stay visible. Optional rooms start muted for that person. Claimable interest roles are a separate flag on role definitions. Staff roles stay staff-assigned.

**Tech Stack:** WabiDB `ChannelKind` + wabi-server socket/API + Svelte 5 board in the existing chat surface.

**Sources to obey:**
- Discord Community Onboarding FAQ: https://support.discord.com/hc/en-us/articles/11074987197975-Community-Onboarding-FAQ
- Discord Onboarding Examples: https://support.discord.com/hc/en-us/articles/10394859532823-Community-Onboarding-Examples
- Discord Server Guide FAQ: https://support.discord.com/hc/en-us/articles/13497665141655-Server-Guide-FAQ
- Discord Rules Screening FAQ: https://support.discord.com/hc/en-us/articles/1500000466882-Rules-Screening-FAQ
- Wabi categories skill: `wabi-categories-implementation`
- Wabi sidebar IA: `wabi-sidebar-channel-ia`
- Current enum: `core/crates/wabidb/src/domain/mod.rs` (`Planning = 12` is last)

**Product rules (do not violate):**
- One room in the normal mixed channel list. No extra tab above the sidebar.
- Never force completion before chat.
- Never put server rules in the desk.
- Never let Reception assign `owner` / `admin` / `mod`.
- Do not invent a third visibility system. “Up” = not in this user’s muted list + hide-muted on. “Off” = muted for this user.
- Do not nest `#reception`. Pin it at the top of the mixed root list.
- Do not auto-create Reception on existing servers. Owner/admin creates it.
- English-only UI copy.
- No day/effort estimates in comments or commits.
- Do not touch whiteboard WIP, lore, or unrelated dirty files.
- `ChannelKind` is append-only. Next value is `Reception = 13`. Never renumber.
- After `cargo test -p wabi-core --features ts`, re-append `"reception"` to generated `ChannelType.ts` if ts-rs stripped it.

**Visual bar:** better than Discord’s survey. One living card, not a form wizard. Short chips. Live preview of what turns on. Ghosted “Member since” energy, not SaaS progress dots.

---

## End state the worker is aiming at

```
#reception          ← always at top, cannot nest
#general            ← default, always up
📁 art              ← optional; chip turns folder + Artist role on
#voice              ← optional or default, owner chooses
```

Opening `#reception` shows a board above chat:

```
Welcome to {server}
How others will see your rooms

Who are you here as?     [Artist] [Writer] [Voice] [Dev]
Rooms you want up        tree of folders/channels with on/off
                         defaults locked on
[Show me the server]     switches to #general
```

Staff can still talk in the channel under the board.

---

### Task 1: Append ChannelKind::Reception

**Objective:** Add the domain kind without shifting existing discriminants.

**Files:**
- Modify: `core/crates/wabidb/src/domain/mod.rs`
- Test: same file’s `channel_kind_repr_is_u8` (or add one next to it)

**Steps:**
1. Append only:
   ```rust
   /// Reception desk — welcome + personal room/role board.
   /// Stable wire value: channel_type "reception". Append-only — never renumber.
   Reception = 13,
   ```
2. Add/extend the discriminant test:
   ```rust
   assert_eq!(ChannelKind::Planning as u8, 12);
   assert_eq!(ChannelKind::Reception as u8, 13);
   ```
3. Run: `cargo test -p wabidb --lib channel_kind_repr_is_u8`
   Expected: PASS
4. Commit: `feat(reception): append ChannelKind::Reception = 13`

---

### Task 2: Wire reception through adapter + create API

**Objective:** Server can create and list a reception channel as `type: "reception"`.

**Files:**
- Modify: `core/crates/wabi-server/src/adapter/mod.rs` (`get_channels_raw` kind match ~863)
- Modify: `core/crates/wabi-server/src/api/channels.rs` (kind → string and string → kind)
- Modify: `core/crates/wabi-server/src/socketio/shared.rs` if it maps kinds
- Search: `ChannelKind::Planning` and add a sibling arm everywhere

**Rules:**
- Missing match arms fail compile (`E0004`). Grep `ChannelKind::` after the edit.
- Create path must accept `type: "reception"` / `"reception"`.
- Only one reception channel per server. Second create returns a clear error: `Reception already exists`.
- Creation sets `parent_id = None` even if the client sent a folder.

**Verify:** `cargo check -p wabi-server`

**Commit:** `feat(reception): accept and list reception channels`

---

### Task 3: Protocol + frontend type

**Objective:** TypeScript knows `reception`.

**Files:**
- Modify: `packages/wabi-protocol/src/generated/ChannelType.ts` — add `"reception"`
- Modify: `frontend/src/lib/socket-types.ts` if it omits generated types
- Modify: `frontend/src/lib/channelStore.ts` `CreateableChannelType` — add `'reception'`
- Modify: `frontend/src/lib/socketConnectionCore.ts` `normalizeChannel` — pass `reception` through like `planning`

**Do not** treat reception as lore/text fallback.

**Commit:** `feat(reception): add reception to frontend channel types`

---

### Task 4: Personal room list helpers (no new storage)

**Objective:** “Channels up” is mute + hide-muted, with reception/general forced visible.

**Files:**
- Create: `frontend/src/lib/receptionDesk.ts`
- Create: `frontend/src/lib/receptionDesk.test.ts`
- Modify: `frontend/src/lib/serverSettings.ts` — add `setServerChannelMuted(channelId, muted: boolean)` so the board is not forced to toggle-blindly
- Modify: `frontend/src/lib/displayEnhancements.ts` — when a user first uses Reception, turn `hideMutedCategoriesEnabled` on if they opted rooms off. Do not globally flip it for everyone on load.

**API to implement in `receptionDesk.ts`:**

```ts
export const RECEPTION_ALWAYS_UP = new Set(['reception', 'general']);

export function isReceptionChannel(ch: { type?: string; id?: string; name?: string }): boolean {
  return ch.type === 'reception' || ch.id === 'reception' || ch.name === 'reception';
}

export function isAlwaysUp(ch: { type?: string; id?: string; name?: string }): boolean {
  return isReceptionChannel(ch) || ch.id === 'general' || ch.name === 'general';
}

export function roomsForDesk(channels: Channel[]): Channel[] {
  // exclude dm, group, thread_*, reception itself
}

export function applyRoomUp(channelId: string, up: boolean): void {
  if (isAlwaysUp({ id: channelId })) return;
  setServerChannelMuted(channelId, !up);
}
```

**Tests (bun):**
- reception + general cannot be muted by `applyRoomUp`
- applying off adds the id to muted list
- applying on removes it

Run: `bun test ./src/lib/receptionDesk.test.ts`

**Commit:** `feat(reception): personal room-up helpers on mute list`

---

### Task 5: Sidebar treats reception as pinned root

**Objective:** Reception always renders first in the mixed root list and cannot be nested.

**Files:**
- Modify: `frontend/src/lib/components/sidebar/channelSidebarHelpers.ts` `buildMixedRoot`
- Modify: `frontend/src/lib/components/sidebar/channelSidebarHelpers.test.ts`
- Modify: `frontend/src/lib/components/ChannelSidebar.svelte`
  - include reception in `unifiedSidebarChannels` (or pin it outside the each)
  - block `moveChannelToCategory` / drops that would set `parentId` on reception
- Modify: `frontend/src/lib/components/sidebar/CreateChannelForm.svelte` — add a Reception chip, owner/admin only, hidden if one already exists
- Modify: `frontend/src/lib/components/sidebar/UnifiedChannelList.svelte` — reception icon (desk / door, not hash). No sunburst gear.

**`buildMixedRoot` rule:** after sorting by position, stable-partition reception to index 0.

**Test:** mixed list with `general` position 0 and `reception` position 9 still starts with reception.

Run: `bun test ./src/lib/components/sidebar/channelSidebarHelpers.test.ts`

**Commit:** `feat(reception): pin reception at top of mixed list`

---

### Task 6: Claimable interest roles (data)

**Objective:** Role definitions can be marked claimable. Staff roles cannot.

**Files:**
- Find the role definition persist path (start at `assign-role` in wabi-server socket handlers and `roleDefinitions` in `presenceStore.ts`).
- Add `claimable: boolean` (default false) to the role definition record / wire view.
- Reject `claimable: true` for `owner`, `admin`, `mod`.
- Add `claim-role` / `unclaim-role` socket events that:
  - require the caller to be the target
  - require `claimable === true`
  - reuse existing `assign-role` / `remove-role` internals

**Frontend:**
- Extend `RoleDefinition` in `frontend/src/lib/presenceStore.ts` / socket types with `claimable?: boolean`.
- Add `claimRole(roleName)` / `unclaimRole(roleName)` next to `assignRole`.

**Tests:** Rust unit test: claiming `admin` errors; claiming a `claimable` artist role succeeds for self.

**Commit:** `feat(reception): claimable interest roles`

---

### Task 7: Reception board component

**Objective:** The visual desk. Better than Discord’s survey.

**Files:**
- Create: `frontend/src/lib/components/reception/ReceptionDesk.svelte`
- Create: `frontend/src/lib/components/reception/ReceptionDesk.css`
- Create: `frontend/src/lib/receptionWorkspace.ts` only if needed for open helpers — prefer rendering from channel type, not a new addon tab.

**Svelte 5:** `$props()`, `$state()`, `$derived()`, `onclick` (not `on:click`).

**Layout:**
- Full-bleed card in the chat surface, above `MessageList` when `$currentChannel` is reception.
- Left / top: welcome + role chips.
- Right / bottom: room tree with switches.
- Footer button: `Show me the server` → `switchChannel('general')`.
- Status: live preview line, e.g. `3 extra rooms on · Artist`.
- Defaults show a lock / “always on”, not a dead checkbox.
- Role chips: selected = filled accent, unselected = ghost border.
- Room rows: folder header switch toggles all children except always-up; child can still flip alone.
- Empty claimable-roles state: `No interest roles yet. Ask an owner to mark some claimable.`
- Do not mention Discord. Do not show progress steps.

**Do not** mount this as a `mobileTabQueue` addon. It is the channel.

**Commit:** `feat(reception): desk board UI`

---

### Task 8: Mount board in Chat, not a workspace pill

**Objective:** Opening the reception channel shows the desk + still allows chat underneath.

**Files:**
- Find the channel-type switch in `frontend/src/lib/components/Chat.svelte` / `MainLayout.svelte` (same place wiki/lore/planning shells mount).
- When current channel `type === 'reception'`, render `<ReceptionDesk />` above the message list.
- Keep composer. Staff conversation belongs here.
- ChatHeader workspace pills stay unchanged. No Reception pill.

**Commit:** `feat(reception): show desk inside the reception channel`

---

### Task 9: Owner config for defaults + welcome copy

**Objective:** Owner/admin can set welcome text and which rooms are defaults.

**Minimum v1 (do this, not a CMS):**
- Welcome text: channel `description` of the reception channel. Desk reads it.
- Default rooms: any channel that is **not** muted-by-default. Store a server-level list.

**Files:**
- Add `receptionDefaults: string[]` to the existing server settings persist path (search `serverSettings` backend; if none, store on the reception channel description JSON **only if** no server-settings table exists — prefer a real server setting).
- Channel settings modal: if channel is reception, show “Welcome copy” + “Default rooms” checklist (exclude dm/group/threads).
- New users: on first presence/init, mute every non-default, non-always-up room once. Gate with `localStorage` key `wabi:reception:seeded:{serverUrl}:{userId}` so existing users are not mass-muted.

**Do not** seed-mute existing accounts.

**Commit:** `feat(reception): welcome copy and default rooms`

---

### Task 10: Wire chips to roles + rooms

**Objective:** One chip can turn on a folder and claim a role.

**Config shape (owner-editable later; hardcode a sensible default map for v1 if no admin UI yet):**

```ts
type ReceptionOffer = {
  id: string;
  label: string;          // Artist
  roleName?: string;      // must be claimable
  channelIds: string[];   // folder + children or explicit list
};
```

v1 acceptable default if no config exists:
- One offer per top-level folder, label = folder name, `channelIds` = folder children, no role until owner marks one claimable.

Click chip on:
- `claimRole` if roleName set
- `applyRoomUp(id, true)` for each channelId

Click chip off:
- `unclaimRole`
- `applyRoomUp(id, false)` unless channel is always-up or a default room

**Commit:** `feat(reception): chips claim roles and raise rooms`

---

### Task 11: Tests and anti-Discord regressions

**Objective:** Lock the product rules.

**Files:**
- `frontend/src/lib/receptionDesk.test.ts`
- sidebar helper tests
- optional Rust create-duplicate test

**Assert:**
- cannot nest reception
- reception sorts first
- cannot mute reception/general via desk helpers
- cannot mark admin claimable
- ChatHeader has no Reception pill
- no new `mobileTabQueue` addon id named reception

Run:
```
bun test ./src/lib/receptionDesk.test.ts ./src/lib/components/sidebar/channelSidebarHelpers.test.ts
cargo test -p wabidb --lib channel_kind_repr_is_u8
cargo check -p wabi-server
```

**Commit:** `test(reception): desk invariants`

---

## Worker constraints

**Allowed to touch:**
- `core/crates/wabidb/src/domain/mod.rs`
- `core/crates/wabi-server/src/adapter/mod.rs`
- `core/crates/wabi-server/src/api/channels.rs`
- `core/crates/wabi-server/src/socketio/**` (role + channel create only)
- `packages/wabi-protocol/src/generated/ChannelType.ts`
- `frontend/src/lib/channelStore.ts`
- `frontend/src/lib/socketConnectionCore.ts`
- `frontend/src/lib/socket-types.ts`
- `frontend/src/lib/presenceStore.ts`
- `frontend/src/lib/serverSettings.ts`
- `frontend/src/lib/displayEnhancements.ts`
- `frontend/src/lib/receptionDesk.ts` (+ test)
- `frontend/src/lib/components/reception/**`
- `frontend/src/lib/components/sidebar/**`
- `frontend/src/lib/components/ChannelSidebar.svelte`
- `frontend/src/lib/components/Chat.svelte` / the real channel-shell host
- `frontend/src/lib/components/sidebar/ChannelSettingsModal.svelte`

**Do not touch:**
- whiteboard files
- lore/code workspace
- profile settings (separate track)
- `ChatHeader.svelte` workspace pills
- `mobileTabQueue.ts` unless a compile error forces a one-line type update

**Do not:**
- `git add -A`
- commit unrelated dirty tree
- deploy
- invent Browse Channels
- invent pre-join screening
- hide the composer in reception

---

## Hermes review checklist (after the henchman)

1. `ChannelKind::Reception = 13` only, Planning still 12.
2. Second reception create is rejected.
3. Mixed list still allows channels above folders; reception is the only forced top pin.
4. Desk is in the channel, not a workspace pill / right panel / fullscreen stage.
5. Mute list is the only “off” mechanism.
6. No staff role claim path.
7. Existing users were not mass-muted.
8. Visual: one card, chips, live preview, no wizard chrome.
9. Scoped `git diff --stat` matches the allowed file list.

---

## Explicitly deferred

- Pre-join questions
- Rules screening
- Server Guide todos / resource pages that remove channels from the list
- Recommended-for-you ML
- Forced onboarding before send
- Auto-create Reception on every existing server
