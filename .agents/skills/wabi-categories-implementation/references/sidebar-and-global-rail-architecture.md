# Sidebar Organization & Global Rail Architecture (2026-08-18)

## Sidebar hardcoded-by-kind structure

`ChannelSidebar.svelte` organizes top-level sections **by channel kind**, not by any
user-defined grouping. The pattern:

```typescript
let isTextSectionExpanded = true;
let isVoiceSectionExpanded = true;
let isGallerySectionExpanded = true;
let isForumSectionExpanded = true;
let isWikiSectionExpanded = true;
let isLoreSectionExpanded = true;
let isPlanningSectionExpanded = true;
```

Each kind gets its own list component:
`TextChannelList`, `VoiceChannelList`, `GalleryChannelList`, `ForumChannelList`,
`WikiChannelList`, `LoreChannelList`.

So there is a literal "Voice" section, a "Text" section, etc. — hardcoded by
channel type. This is the "hard labeling" that **Sections** (definable buckets)
are intended to replace.

The seed of definable grouping already exists: `buildMixedRoot()` in
`channelSidebarHelpers.ts` supports folders (category channels) + uncategorized
channels sharing one position space.

## CRITICAL NAMING COLLISION — ServerRail already exists

Before creating a new rail/component in Wabi, **verify no naming collision AND
verify the existing component's actual purpose**. `ServerRail.svelte` already exists
at `frontend/src/lib/components/ServerRail.svelte` — but it is the **server
switcher** rail (saved servers + folders, switching between communities via
`savedServerRailItems`), NOT a surface switcher.

The mockup's far-left rail is the **surface switcher** (home/chat/calendar/tasks/files
/settings — switching surfaces within a community). These are two completely
different rails doing two different jobs:

| Rail | File | Job | Scope |
|------|------|-----|-------|
| Server switcher | `ServerRail.svelte` | which community | cross-server |
| Surface switcher | (new) | which surface within a community | per-server |

**Never assume a component's purpose from its name alone.** The word "Rail" in
`ServerRail` refers to the saved-server rail. A new surface switcher should be
named differently (e.g. `SurfaceRail`) to avoid collision and confusion.

## Follow vs Pin vs Bookmark (three distinct primitives)

| Primitive | Scope | Owner | Question it answers |
|-----------|-------|-------|---------------------|
| Follow (`FollowingFeed.svelte`) | cross-server, global | user (device-local) | "what's new?" |
| Pin (`PinnedMessagesModal`, `pinnedBy`) | per-channel | server/room | "what's important here?" |
| Bookmark / Star | cross-surface, per-self | user | "where did I put that thing?" |

Follow is a firehose (aggregated new content + alert levels + lightweight
cross-server snapshots). Bookmark is a durable reference list. They are
complementary — do not replace follow with bookmarks or merge them.

Follow = global manager (cross-server watch). Sections = per-server manager
(how this community is organized). Different scopes, different jobs.

## Global rail architecture (the far-left icon dock)

From mockup + discussion. NOT hover-driven (hover hides discoverability, breaks
touch, triggers on mouse-accident). Three density states, user-toggled:

1. **Full** — icon + label (default for new users / onboarding)
2. **Icons-only** — slim column, tooltip on hover (daily driver, Discord's actual default)
3. **Hidden** — thin swipe-edge or toggle brings it back

Side placement: **left OR right**, per-user setting. Stored per-user.

Internal structure (visually distinct groups):
- **Identity anchor** — server logo at very top → navigates to server hub. Not a surface toggle.
- **Surface icons** — home, chat, calendar, tasks, files. Grouped below the logo.
- **Settings** — pinned to very bottom, separated from surface group.

## Bookmarks: pointer-not-copy permission model

A bookmark grants zero access by itself. Resolves against the viewer's *current*
ACL on every render. Four render states:

1. Accessible → render normally
2. Lost permission + self-bookmark → tombstone: "You no longer have permission to view this." (self-only: you made the pointer, silent deletion feels like data loss, but leak nothing)
3. Lost permission + server pin → silently omit (it was never yours)
4. Dissolved/deleted target → tombstone: "This was removed." (decay lane, distinct from permission)

Rule: **omit the pins you don't own; tombstone the bookmarks you do.**

Backs onto WabiDB retention engine (per-scope TTL with cryptographic deletion).
Everything decays by default; a bookmark is the explicit opt-out.

## The three levels of channel identity

| Level | What | Definable? | Drives |
|-------|------|------------|--------|
| Kind (`ChannelKind`: Voice/Text/Wiki/Lore/...) | fixed, functional | No | backend behavior + icon |
| Name ("Team Standups") | user-defined | Yes | the label |
| Section (top-level bucket) | currently hardcoded = kind | Yes (the new thing) | which bucket |

The hardcoded type label string (e.g. "voice channel" from `getChannelTypeLabel`)
should collapse into (kind icon + channel name). Icon carries the kind, name
carries the identity. No hardcoded "voice channel" text.
