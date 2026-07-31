# Card D4 — Context menus

Date: 2026-07-23
Worker: opencode/laguna-s-2.1-free (partial) + Hermes captain finish

## Inventory (high level)
| Surface | Menu? | Notes |
|---|---|---|
| Message rows | Yes | MessageContextMenu |
| Users / members list | Yes | UserContextMenu |
| Channel list | Yes | ChannelSidebar right-click |
| Gallery cards | Yes (new) | open/share/download/copy/delete |
| Notes list | Yes (new) | open/pin/color/reader/delete |
| Voice members | Partial | channel right-click only; member UserContextMenu deferred |
| DM hub rows | Existing click paths | |

## Changes
- Gallery item context menu (Laguna)
- Notes context menu handlers + wire-up (Laguna partial + captain finish)
- ContextMenu icon types: share, book-open
- Fixed invalid Svelte `$:` TypeScript annotations on menu item arrays

## Remaining
- Voice member row → UserContextMenu
- Deeper submenu/folder pattern for long menus
