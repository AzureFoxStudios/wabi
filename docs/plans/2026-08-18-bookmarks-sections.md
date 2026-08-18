# Bookmarks, Favorites & Definable Sections

Status: design
Date: 2026-08-18
Source: Discord mockup (`dashboard_20260818_105600_f1144370_image.png`) + product discussion

## Origin

A community member ("k") sketched what Wabi could look like, drawing on
Obsidian + Trello as references on top of Discord. The mockup shows:

- Three top tabs — `Comms` / `Work` / `Knowledge`
- `FAVORITES` (star) holding heterogeneous items (channel, folder, voice, calendar)
- `MESSAGES` as an inbox (DMs / Mentions / Unreads with counts)
- `PROJECTS` folders, `ARCHIVE` lane
- Far-left global rail (home, chat, calendar, tasks, files, settings)

The design discussion concluded three things matter, and they are **distinct**:

1. Follow already exists and is a different thing — do NOT replace it.
2. Bookmarks (per-self save list) do NOT exist — new, and scoped to the self only.
3. "Sections" should be **definable** (server + user), not three hardcoded lanes.

## The three primitives (don't conflate them)

| Primitive | Exists? | Scope | Owner | Meaning | Question it answers |
|-----------|---------|-------|-------|---------|---------------------|
| **Follow** | yes (`FollowingFeed.svelte`) | cross-server | user (device-local) | watch new activity across servers | "what's new?" |
| **Pin** | yes (`PinnedMessagesModal`, `pinnedBy`) | per-channel | server/room | "this matters to this room" | "what's important here?" |
| **Bookmark / Star** | **no** | cross-surface, per-self | user | durable reference pointer | "where did I put that thing?" |

Follow is a firehose (aggregated new content + alert levels + snapshots).
Bookmark is a reference list. They are complementary. Keep follow untouched.

## Part A — Bookmarks (the per-self save list)

The privacy-critical design: **a bookmark is a pointer, not a copy.** It grants
zero access by itself and resolves against the viewer's *current* ACL on every
render. This single rule kills the harvesting/stalking vector: you cannot
bookmark your way into content, and losing access immediately de-scopes the view.

### Data shape

A bookmark is a personal, per-user record: `{ user_id, target_kind, target_id,
optional tag, optional note, created_at }` where `target_kind ∈ { message,
channel, wiki_page, lore_file, planner_card, calendar_event, ... }`.

Stored as a per-user collection (WabiDB projection keyed by user), **never** a
shared server-side graph. Edges are owned, not exposed cross-user.

### Render states (four-way machine)

1. **Accessible** → render normally (icon, title, unread).
2. **Lost permission, self-bookmark** → tombstone: *"You no longer have
   permission to view this."* (Self-only: you made the pointer; silent deletion
   feels like data loss, but leak nothing — no title, no channel, no content.)
3. **Lost permission, server pin** → **silently omit** (it was never yours; a
   tombstone for a room you were kicked from is noise + mildly hostile).
4. **Dissolved/deleted target** → tombstone: *"This was removed."* (decay lane,
   distinct from permission lane — don't conflate "can't see" with "gone").

The rule: **omit the pins you don't own; tombstone the bookmarks you do.**

### Decay

Backs onto WabiDB's retention engine (`per-scope TTL with cryptographic
deletion`). Everything decays by default; a bookmark is the explicit opt-out
that keeps a target (and its edge) alive. Un-bookmarked content dissolves.

## Part B — Definable Sections (the big idea)

Sections are **top-level, named, server-or-user-definable groupings** that can
contain any mix of channels, folders, and pinned surfaces (wiki / planner /
calendar / files). `Comms/Work/Knowledge` is one example; `Talk/SFW/NSFW` and
`Cosplay/Photography/Jobs` are equally valid. Do NOT bake three lanes.

### Current state (verified in code)

The sidebar's top-level organization is **hardcoded by channel kind**, not by
any user-defined grouping. `ChannelSidebar.svelte` has per-kind section state
(`isVoiceSectionExpanded`, `isTextSectionExpanded`, `isGallerySectionExpanded`,
`isForumSectionExpanded`, `isWikiSectionExpanded`, `isLoreSectionExpanded`,
`isPlanningSectionExpanded`) and one list component per kind
(`VoiceChannelList`, `TextChannelList`, `GalleryChannelList`,
`ForumChannelList`, `WikiChannelList`, `LoreChannelList`).

So there is a literal "Voice" section, a "Text" section, etc. — hardcoded by
channel type. **This is the "hard labeling" that sections replace.**

Alongside it, `buildMixedRoot()` (`channelSidebarHelpers.ts`) already supports
folders (category channels) + uncategorized channels sharing one position
space. That is the seed of definable grouping.

### The three levels (grounded)

- **Kind** (`ChannelKind`: Voice/Text/Wiki/Lore/...) — fixed, functional,
  drives backend behavior + the icon. Never user-definable.
- **Name** ("Team Standups", "# general") — already user-defined.
- **Section** (top-level bucket) — **currently hardcoded = kind** ("Voice",
  "Text", "Gallery"...); **becomes server/user-definable** ("SFW", "Cosplay",
  "Jobs"...).

### Model

- **Server default sections** — owner/admin defines the set + order + membership.
- **User overrides** — a user can reorder, rename, hide, or add personal
  sections on top of the server defaults (stored per-user, like a layout).
- **Default template** — new servers get a starter scheme (e.g. one "General"
  section) rather than a forced triple.

### Open questions (resolve before build)

- How do the existing per-kind list components (`VoiceChannelList` etc.)
  collapse into a single sectioned list keyed by definable bucket instead of
  by `type === 'voice'`? (Recommend: one `UnifiedChannelList` driven by the
  section model; per-kind components remain for their inner rendering.)
- Does a Section inherit only child-channel permissions (recommended: yes, no
  new ACL surface), and can a section pin a *surface* (wiki/planner/calendar)
  in addition to channels?
- Is the far-left global rail (home/chat/calendar/tasks/files/settings) in the
  mockup a *separate* app-level concern from per-server sections?
  (Recommend: separate — global rail = app chrome; sections = per-server.)

## Non-goals

- No cross-user link/social graph. The graph (if/when built) is per-self,
  knowledge-scoped (notes/files), never "who messaged whom."
- No new ACL/visibility surface for bookmarks — resolve against existing ACLs.
- No auto-promotion of ephemeral content into permanent notes. Permanence is
  always an explicit human act.

## Part C — Global rail (the far-left icon dock)

The mockup shows a far-left vertical icon rail: home, chat, calendar, tasks,
files, settings. You spent much of the project trying to kill this rail, and
rightly — a fully-expanded label rail is clutter. But the rail is functional
(Discord has it for a reason), so the correct answer is **add it back with a
narrow default and a user-tunable side + density.**

### Three density states (user-toggled, NOT hover-driven)

1. **Full** — icon + label, default for new users / onboarding.
2. **Icons-only** — slim icon column, tooltip on hover. The daily driver.
3. **Hidden** — for the people who hate it; a thin swipe-edge or `[` / `]` toggle
   brings it back.

Hover-to-reject is the wrong solution: it hides discoverability, breaks touch,
and triggers on mouse-accident. Discord's actual default is icons-only — it
works because the icons are always visible, just compact.

### Side placement: left OR right

A user setting — the rail can pin to the **left or right** edge of the viewport.

- The mockup defaults to left (Discord convention).
- Flipping to right is a common accessibility + preference option (right-handed
  users who want the rail out of the primary left-to-right reading flow; RTL
  layouts; or simply "I've always used it there").
- Stored per-user. The section sidebar stays on its native side.

### Internal structure

The rail mixes two jobs — keep them visually distinct:

- **Identity anchor** — the server logo at the very top, goes to the server
  hub (as the mockup shows). Not a surface toggle, just the identity home.
- **Surface icons** — home, chat, calendar, tasks, files. Grouped below the
  logo. These switch the active surface/workspace.
- **Settings** — pinned to the very bottom, separated from the surface group.

Do not let the logo get lost in the icon list. It's the identity anchor, not a
surface button.

## Task list (unscoped / not yet sequenced)

- [ ] Confirm Section vs Category relationship (above, or a rename of the existing sidebar grouping).
- [ ] Confirm far-left rail vs per-server section rail split.
- [ ] Define bookmark target_kind enum + per-user projection in WabiDB.
- [ ] Bookmark action surfaced consistently across surfaces (message / wiki / lore / planner / calendar).
- [ ] Favorites/Starred view (list + optional tag/note + filter by surface).
- [ ] Four-state permission render machine (tombstones, silent omit).
- [ ] Retention-engine integration (bookmark = opt-out of decay).
- [ ] Server-default + user-override section model (create/reorder/rename/hide).
- [ ] Default section template for new servers.
- [ ] Pin vs star visual distinction (pin glyph = shared, star = personal).
- [ ] Global rail: add back as narrow icon dock with three density states (full / icons-only / hidden).
- [ ] Global rail: side placement toggle (left OR right), per-user.
- [ ] Global rail: identity anchor (server logo → hub) separated from surface icons + settings at bottom.
