# Context Menu Bible (Discord Compass)

Last updated: 2026-02-16
Scope: Right-click and long-press interaction model across messages, users, channels, and DMs.

## 1) Research anchors (what Discord is doing)

- Context actions are surface-aware and available via right-click on desktop and tap-and-hold/long-press on mobile.
- Message-level actions are split between fast hover actions and context menu actions.
- Message action set in current Discord help/docs includes Reply, Pin, Forward, Bookmark, and app-provided actions under `Apps`.
- Keyboard support is first-class on desktop: context menus and list-like surfaces are arrow-key navigable; message actions also have direct shortcuts.
- Third-party extensibility is explicit in context menus: `Apps` submenu with user/message context commands.

Primary evidence:
- Keyboard navigation + message shortcuts (`+`, `r`, `e`, `Backspace`, `p`, copy):
  - https://support.discord.com/hc/en-us/articles/1500000056121-Keyboard-Navigation-FAQ
- Reply via right-click (desktop) and long-press (mobile):
  - https://support.discord.com/hc/da/articles/360057382374-Replies-FAQ
- Pin message via message menu/right-click + permissions:
  - https://support.discord.com/hc/en-us/articles/221421867-How-do-I-pin-messages
- Forwarding via hover bar (desktop) and long-press menu (mobile):
  - https://support.discord.com/hc/en-us/articles/24640649961367-Message-Forwarding
- Bookmark message via right-click (desktop) and long-press (mobile):
  - https://support.discord.com/hc/en-us/articles/26442819646999-Message-Bookmarks-and-Reminders
- Apps submenu and right-click integration:
  - https://support.discord.com/hc/en-us/articles/21334461140375-Using-Apps-on-Discord
- Developer command model for context menus (`USER`, `MESSAGE`):
  - https://docs.discord.com/developers/interactions/application-commands
- Accessibility pattern baseline for menu buttons and menus:
  - https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/

## 2) Current codebase audit (where we are)

You currently have multiple independent menu implementations:

- Message menu: `frontend/src/lib/components/MessageContextMenu.svelte`
- User menu: `frontend/src/lib/components/UserContextMenu.svelte`
- Channel menu inline: `frontend/src/lib/components/ChannelSidebar.svelte`
- DM menu inline + temporary TODOs: `frontend/src/lib/components/DMListPanel.svelte`
- User list tab menu inline: `frontend/src/lib/components/UserListTab.svelte`

Key issues discovered:

- Fragmented architecture and duplicated behavior/styles across 5 menus.
- Incomplete DM actions are explicitly temporary/TODO (`archive`/`delete` not implemented):
  - `frontend/src/lib/components/DMListPanel.svelte:110`
  - `frontend/src/lib/components/DMListPanel.svelte:118`
- Message context menu suppresses a11y checks instead of implementing keyboard/menu semantics:
  - `frontend/src/lib/components/MessageContextMenu.svelte:47`
  - `frontend/src/lib/components/MessageContextMenu.svelte:53`
- User context menu container is given `role="button"` + `tabindex` instead of menu roles:
  - `frontend/src/lib/components/UserContextMenu.svelte:80`
  - `frontend/src/lib/components/UserContextMenu.svelte:81`
- Visuals are hardcoded in multiple menus instead of tokenized/themed consistently:
  - `frontend/src/lib/components/MessageContextMenu.svelte:130`
  - `frontend/src/lib/components/UserContextMenu.svelte:137`
- Message features are partially modern (reply, reactions, forward, pin, copy, delete) but not unified with other surfaces:
  - `frontend/src/lib/components/MessageContextMenu.svelte:61`
  - `frontend/src/lib/components/MessageContextMenu.svelte:104`
- Long-press is present on core surfaces (good foundation), but parity rules are not centralized:
  - `frontend/src/lib/components/MessageList.svelte:539`
  - `frontend/src/lib/components/ChannelSidebar.svelte:311`
  - `frontend/src/lib/components/DMListPanel.svelte:200`
  - `frontend/src/lib/components/UserPanel.svelte:217`

## 3) Canonical menu system (target state)

### 3.1 Core principles

- One shared context-menu framework, many data-driven menus.
- Same action model for right-click (desktop) and long-press (mobile).
- Fast actions on hover bar for top 2-3 frequent actions; full list in menu.
- Permissions gate visibility and enabled state.
- Destructive actions grouped at bottom, visually separated.
- App extension slot (`Apps`) is reserved in message/user menus.

### 3.2 Menu anatomy

- Header (optional): entity preview (user/channel/message metadata).
- Action group(s): ordered by frequency, then risk.
- Divider(s): semantic grouping only.
- Danger group: delete/leave/remove.
- Secondary metadata lane (optional): shortcut hint, status chip, chevron for submenu.

### 3.3 Canonical action ordering (v1)

Message menu:
- Reply
- Add Reaction
- Forward
- Bookmark / Reminder (if supported in product)
- Copy Text
- Pin/Unpin
- Apps >
- Divider
- Edit (own only)
- Delete (own/mod only, danger)

User menu:
- Message
- Voice Call
- Video Call
- View Profile
- Divider
- Role/admin actions (if permissioned)
- Apps >
- Divider
- Block/Report (if product supports, danger/critical section)

Channel menu:
- Mark as Read
- Mute/Notification settings
- Pin Channel
- Open Settings
- Divider
- Delete/Leave (permissioned danger)

DM menu:
- Open
- Mark as Read
- Pin/Favorite
- Mute
- Divider
- Archive/Close
- Delete/Leave (if supported, danger)

## 4) Interaction contract (must-haves)

Desktop:
- Open on `contextmenu` and on overflow trigger button.
- Keyboard: arrow navigation, Enter/Space activate, Esc close, Tab exits cleanly.
- Typeahead optional for dense menus.
- Positioning: smart flip on viewport collision.

Mobile:
- Open on long-press with haptic-ready hook.
- Same action set as desktop (except non-mobile-safe actions).
- Minimum 44px target height.
- Dismiss on outside tap or swipe-away if sheet pattern is used.

State + close behavior:
- Close on action success, outside click, Esc, route change, and anchor unmount.
- Keep open on transient recoverable errors where retry is useful.

## 5) Accessibility contract

- Use APG menu button pattern semantics:
  - Trigger: `button` + `aria-haspopup="menu"` + `aria-expanded`
  - List: `role="menu"`
  - Items: `role="menuitem"` / checkbox/radio variants where needed
- Roving focus or `aria-activedescendant` for keyboard navigation.
- Do not rely on `svelte-ignore` for core interaction semantics.
- Preserve visible focus ring and contrast in all themes.

## 6) Architecture proposal (implementation-ready)

Introduce shared primitives:

- `ContextMenuHost.svelte`
- `ContextMenuSurface.svelte`
- `ContextMenuItem.svelte`
- `ContextMenuSection.svelte`
- `useContextMenu.ts` action/store for open/close/position/state
- `menuSchemas.ts` for data-driven action definitions per entity

Action schema (conceptual):

- `id`, `label`, `icon`, `shortcut`, `danger`, `disabled`, `visible`
- `group`, `submenu`, `onSelect(context)`
- `permission(context)`, `mobileSupport`, `desktopSupport`

## 7) Priority roadmap

P0 (foundation):
- Build shared menu primitives + keyboard/a11y contract.
- Migrate message menu first (highest traffic).

P1:
- Migrate user, channel, DM menus to shared primitives.
- Remove temporary DM TODO placeholders by implementing real archive/delete behavior or hiding unavailable actions.

P2:
- Add `Apps` submenu slot plumbing.
- Add shortcut hint rail and telemetry.

P3:
- Add advanced actions (bookmark/reminder equivalents) where product scope allows.

## 8) Metrics to track during rollout

- Action selection rate by item and surface.
- Time-to-action (open -> select).
- Menu cancel rate.
- Misclick/undo rate on destructive actions.
- Keyboard-driven selection rate.
- Mobile long-press success rate.

## 9) Non-goals for this phase

- Pixel-perfect cloning of Discord.
- Shipping every Discord action immediately.
- Rewriting unrelated chat rendering logic.

## 10) Immediate next implementation step

Create shared menu infrastructure and migrate `MessageContextMenu` first, preserving existing actions and wiring in correct ARIA + keyboard semantics before visual polishing.
