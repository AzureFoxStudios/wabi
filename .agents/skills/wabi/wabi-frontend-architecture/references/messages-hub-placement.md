# Messages hub placement (2026-08-08)

Personal DMs are not channel-list chrome and not a Discord dual rail.

**Do:**
- Sticky row under server identity, above scrollable Channels
- **Messages** label + icon; compact sidebar icon-only + unread badge
- Active when `activeView === 'dm'`; badge = sum unread on `dm`/`group` only
- Opens DmHub (DMs | Notes tabs) — Notes stays a hub sub-tab

**Don't:**
- Full-width card at bottom of channel scroll (scrolls away; fights ProfileCard)
- Icon-only in expanded width
- Weld into server name / top identity chrome
- Separate Notes sidebar icon
- Server channel-count chip on by default (redundant with Channels count)
