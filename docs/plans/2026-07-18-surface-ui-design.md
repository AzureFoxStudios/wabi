# Wabi Surface UI Design — Forum / Wiki / Gallery + Chat-Ref Presentation

**Author:** Kimi (design pass, 2026-07-18)
**Status:** Design contract — ready for hy3 implementation cards
**North stars:** `wabi-channel-specs/{forum,wiki,gallery}_mockup_v2.html` (layout), `frontend/src/styles/tokens.css` (real theme), chat-object-refs spine (chatref-01…07, done)

---

## 0. Design principles

1. **One theme, three surfaces.** Forum, wiki, and gallery are not separate apps — they are channel *modes* that share Wabi's token system, sidebar chrome, and the chat-ref spine. A user should feel they never left Wabi.
2. **Density is a feature, not a bug.** These are power surfaces (old-school forum, curated wiki, Steam-style gallery). We favor information-dense, keyboard-navigable layouts over airy marketing pages. Cozy chat metrics (2px/16px pad, 17px inter-author gap) do NOT apply here — surfaces get their own rhythm.
3. **The chat-ref spine is the connective tissue.** Every object on every surface is shareable to chat (`^f/ ^w/ ^g/ ^m/`) and every chat chip navigates back. Design must make the *share affordance* visible but not noisy.
4. **Tokens, not hex.** All colors/radii/spacing reference `tokens.css` semantic variables (`--surface-base`, `--accent-primary`, `--text-muted`, `--radius-md`, `--space-*`). No hardcoded `#7c5cff` — the mock palette was illustrative; Wabi's real accent is `--accent-primary` (`#6366f1` default, themeable).

---

## 1. Shared layout shell (all three surfaces)

Every non-chat channel mode renders inside the same app frame: server rail (72px) + channel sidebar (240px) + **surface region** (flex-1). The surface region has a consistent two-part scaffold:

```
┌──────────────────────────────────────────────────────────┐
│ SURFACE HEADER  (pad 16px 24px, border-bottom)           │
│  [mode icon + title]  [description]        [+ New …] [⚙] │
├──────────────────────────────────────────────────────────┤
│ SURFACE TOOLBAR (pad 10px 24px, border-bottom, sticky)   │
│  [search]              [filter pills]        [sort ▾]    │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  SURFACE BODY  (mode-specific, see §2/§3/§4)             │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Header** — `--font-size-xl` (20px) title, `--font-size-sm` muted description, primary action button (`+ New Post` / `+ New Page` / `+ New Work`) right-aligned. The `+ New` button is gated by the same `canCreate` logic as channels (owner/admin for channel-level create; members for forum posts / wiki pages / gallery works — see §6 permissions).

**Toolbar** — search input (flex-1, min 200px, `--surface-input` bg, `--border-default`, focus `--border-focus`), filter pills (`--radius-full`, 12px font, active = `--accent-subtle` bg + `--accent-primary` border/text), sort dropdown right-aligned. Sticky at `top:0` within the surface scroll container, `--surface-base` bg, `--z-sticky`.

**Share affordance (global).** Every object card/row/page gets a hover-revealed `⋯` menu (top-right of the card/row) containing **Share to channel…** / **Copy link** / **Copy ref**. This calls `openShareModal(record)` (chatref-05). On touch devices the `⋯` is always visible at 40% opacity. This is the *only* persistent chrome we add for the spine — everything else (chips, unfurl) lives in chat.

---

## 2. Forum — three-pane old-school board

The forum is a **3-pane** layout inside the surface body. This is the densest surface and the one that most rewards muscle memory.

```
┌────────────┬──────────────────┬─────────────────────────────┐
│ CATEGORIES │   POST LIST      │      READING PANE           │
│  (220px)   │   (380px)        │      (flex-1)               │
│            │                  │                             │
│ ▸ Bug 142  │ ┌──────────────┐ │  [tag] [✓ Solved]           │
│  🐛 Crash  │ │ Bug · Solved │ │  Title (22px bold)          │
│  🔊 Audio◄ │ │ Voice cuts…  │ │  @user · 2h · 👁234         │
│  🎨 UI     │ │ 👁234 💬18 ⬆45│ │  ─────────────────────      │
│ ▸ Feat 89  │ ├──────────────┤ │  Body (15px/1.7)            │
│ ▸ Disc 234 │ │ Bug          │ │                             │
│ ▸ Show 56  │ │ Spatial aud… │ │  ── 18 Replies ──           │
│            │ └──────────────┘ │  ┃ solution (green border)  │
│            │  (scroll)        │  ┃   nested reply           │
│            │                  │  ┃ reply                     │
│            │                  │ ─────────────────────────── │
│            │                  │  [Write|Preview] composer   │
└────────────┴──────────────────┴─────────────────────────────┘
```

### Pane 1 — Categories (left, 220px, `--surface-base`)
- Collapsible category groups. Header row: chevron (rotates -90° when collapsed), 8px color dot, title, post count (muted, right).
- Child sub-categories indented 28px, emoji icon + name.
- Active category: `--accent-subtle` bg + `--accent-primary` text. Active child: same.
- Category color dots are per-category themeable (default palette: danger/success/accent/warning/purple).

### Pane 2 — Post list (middle, 380px, `--surface-app`)
- Header: `CategoryName · N posts` + `Mark all read` (muted, clickable).
- Post row (pad 14px 16px, border-bottom `--border-subtle`):
  - Row 1: tag pill(s) + optional `✓ Solved` badge (`--color-success` on `--accent-success-soft`).
  - Row 2: title (`--font-size-base`, semibold, 2-line clamp).
  - Row 3: 16px avatar + author + `·` + relative time + right-aligned stats `👁 views · 💬 replies · ⬆ votes` (muted, `--font-size-xs`).
- Active row: `--accent-subtle` bg + 3px `--accent-primary` left border (pad-left compensates 13px).
- Tag pills: `--radius-full`, 11px semibold. `bug`=danger-soft, `feature`=success-soft, `discussion`=accent-subtle.

### Pane 3 — Reading pane (right, flex-1, `--surface-app`)
- Post detail header (pad 24px 28px, border-bottom): tags, title (`--font-size-2xl` 22px bold), meta row (24px avatar, author semibold, time, view count).
- Body: `--font-size-lg` 15px, `--line-height-relaxed` 1.7, max-width none (forum is wide). Code blocks `--surface-base` + `--border-default` + `--font-mono`.
- Replies section: `N Replies` header (uppercase, muted, letter-spacing). Reply nodes have a 2px `--border-subtle` left rail, indent 14px. **Solution reply**: left rail becomes `--color-success`, bg `--accent-success-soft`, `✓ Solution` badge.
- Nested replies indent further, rail color darkens (`--border-strong`).
- Reply actions: `Reply` / vote `▲ score ▼` / `Share` (→ `openShareModal` for that post). Muted, hover `--accent-primary`.
- Composer pinned at bottom (border-top): Write/Preview tabs, textarea (`--surface-input`, min 80px, resize vertical), footer hint `Ctrl+Enter to post · **bold** \`code\` @mentions` + `Post Reply` primary button.

### Forum responsive
- <1200px: category pane collapses to a horizontal chip strip above the post list.
- <768px: single column — categories become a dropdown, post list and reading pane switch via a tab toggle (`Posts` / `Read`).

---

## 3. Wiki — tree + editorial content + revision drawer

The wiki is the *calm* surface. Generous measure (720px), curated type scale, and a persistent page tree. It should feel like reading well-typeset docs, not a chat log.

```
┌──────────────┬──────────────────────────────────┬───────────┐
│  PAGE TREE   │   CONTENT (max 720px, centered)  │ REVISIONS │
│  (250px)     │                                  │ (280px,   │
│              │  breadcrumb / Edit / History     │  drawer)  │
│ 🏠 Home      │  ────────────────────────────    │           │
│ 📁 Getting…  │  Title (28px/700)                │ 2h Ronin  │
│   📄 Install │  @author · 2h · 12 rev · ●live   │ 5h Alex   │
│   📄 First◄  │  ────────────────────────────    │ 1d Maya   │
│   📄 Common  │  Body (15px/1.65)                │           │
│ 📁 Channels  │  h1 22px / h2 17px / h3 15px     │           │
│ 📁 Contrib   │  p, ul, table, pre, blockquote   │           │
│              │  [📄 wiki-link-card]             │           │
└──────────────┴──────────────────────────────────┴───────────┘
```

### Page tree (left, 250px, `--surface-base`)
- Header: `Pages` (uppercase muted) + `+ New` small button.
- Search input below header.
- Tree rows (pad 6px 12px): chevron (if children), page icon (🏠/📁/📄), title (ellipsis), optional `NEW` badge (`--accent-subtle` bg, 9px bold).
- Active page: `--accent-subtle` bg + `--accent-primary` text. Hover `--surface-hover`.
- Children indent 14px, collapse/expand animated (chevron rotate).

### Content (center, flex-1, `--surface-app`)
- **Sticky toolbar** (top): breadcrumb (`Wiki / Home / Getting Started / First Steps`, links `--text-link`), right-aligned `Edit` + `History` small buttons.
- **Page header** (pad 28px 32px 18px, border-bottom): title `--font-size-3xl` 28px/700, meta row (18px avatar, author, time, `N revisions`, and a **live indicator** — green pulsing dot + `Maya3D editing` when someone else has the page open).
- **Body** (pad 24px 32px 48px, max-width 720px, `--font-size-lg` 15px, line-height 1.65):
  - `h1` 22px/700 with bottom border; `h2` 17px/600; `h3` 15px/600 muted.
  - Inline `code`: `--surface-base` bg, `--font-mono` 13px, `--border-default`.
  - `pre`: `--surface-base`, pad 14px, `--radius-md`, `--font-mono` 13px.
  - `blockquote`: 2px `--accent-primary` left border, italic, muted.
  - `table`: full-width, `--border-default`, header row `--surface-base` uppercase 13px.
  - **Wiki link card** (internal `[[Page]]` or `^w/slug`): inline-flex chip, `--accent-subtle` bg, `--accent-primary` text, 1px accent border, page icon. This is the *same component* as the chat chip (chatref-04) rendered in wiki context — one chip component, two hosts.

### Revision drawer (right, 280px, `--surface-base`, slides in)
- Toggled by `History`. Header `Revisions` + close `✕`.
- Revision items (pad 10px 14px, border-bottom): relative time (muted), editor name (semibold), summary line (muted, 2-line clamp). Active = `--accent-subtle`.
- Clicking a revision loads that version read-only with a `Viewing revision from X — Restore?` banner.

### Wiki responsive
- <768px: tree becomes a slide-over; revision drawer becomes full-width bottom sheet.

---

## 4. Gallery — masonry + lightbox with feedback markers

The gallery is the *visual* surface. Content-first masonry, minimal chrome until hover, and a lightbox that doubles as a critique workspace (numbered feedback markers pinned to image coordinates).

```
┌──────────────────────────────────────────────────────────┐
│ Gallery — Art, WIPs, finished works.      [Sort▾][+ New] │
│ [All][Character][Environment][FFXIV][3D]      [Newest ▾] │
├──────────────────────────────────────────────────────────┤
│  ┌─────┐ ┌─────┐ ┌─────┐                                 │
│  │ img │ │ img │ │ img │   masonry, 3 cols               │
│  │     │ │     │ │WIP  │   (2 @<1200, 1 @<768)           │
│  │     │ └─────┘ └─────┘                                 │
│  └─────┘ title / caption / ❤ 💬                          │
└──────────────────────────────────────────────────────────┘
   LIGHTBOX (fixed inset-0, --z-lightbox):
┌──────────────────────────────────────────────────────────┐
│ Title by author                                      [✕] │
│ [thumb][thumb][thumb]  (strip)                           │
│ ┌──────────────────────────────┬───────────────────────┐ │
│ │                              │ Feedback (3)          │ │
│ │        IMAGE                 │ ① comment…            │ │
│ │   ①    ②      ③  (markers)   │ ② comment…            │ │
│ │                              │ ③ comment…            │ │
│ │                              │ [composer + Send]     │ │
│ └──────────────────────────────┴───────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### Masonry grid (surface body, pad 20px 24px)
- CSS columns: `column-count:3; column-gap:16px` (2 @<1200px, 1 @<768px). Cards `break-inside:avoid`.
- **Gallery card**: `--surface-card` bg, `--radius-lg`, `--border-default`, overflow hidden. Hover: `translateY(-2px)`, `--shadow-lg`, border → `--accent-primary`.
- Image wraps full-bleed; `WIP` badge top-left (`--color-warning` bg, black text, 11px bold, `--radius-full`).
- Hover overlay (gradient from transparent to black, bottom): quick actions — `❤ Like`, `💬 Comment`, `🔗 Share` (→ `openShareModal`). Appears on hover, always visible on touch.
- Card meta (pad 12px): title (14px semibold), caption (12px muted, 2-line clamp), footer row (20px avatar + author | `❤ N · 💬 N`).

### Lightbox (fixed overlay, `--surface-overlay` bg, `--z-lightbox`)
- Toolbar: title + `by author` (muted), close `✕`.
- Filmstrip: 56px thumbs, active = full opacity + `--accent-primary` border.
- Body split: image pane (flex-1, centered, `object-fit:contain`) + feedback sidebar (360px, `--surface-base`).
- **Feedback markers**: numbered circles (24px, `--accent-primary` bg, white number, 2px white ring) absolutely positioned at stored x/y % on the image. Hover scale 1.2. Active = inverted (white bg, accent number). Clicking a marker scrolls the sidebar to that comment and vice-versa.
- Feedback sidebar: header `Feedback (N)` + hint; comment items (number badge + body + author·time); composer at bottom (`Click image to place marker, then type…` + Send).
- **Share** in lightbox toolbar too (same `⋯` menu → `openShareModal`).

### Gallery responsive
- <768px: lightbox sidebar becomes a 40vh bottom sheet; image pane 60vh.

---

## 5. Chat-ref presentation layer (already built — design notes)

These exist (chatref-01…07) but their *visual* contract is defined here so future polish is consistent.

### Inline chips (in chat text)
- `@user` / `#channel` / `^object` render as pill chips: `--accent-subtle` bg, `--accent-primary` text, `--radius-sm`, 1px `--border-focus` at 20% opacity, `--font-size-sm`. Hover: bg deepens to `--accent-medium`, cursor pointer. Icon prefix per kind (👤/📄/🖼/📍/#). Click → `navigateToRef`.
- Chips never break line-height — `display:inline-flex; vertical-align:baseline; padding:0 6px; margin:0 1px`.

### Unfurl card (below message, one per object ref)
- Compact card, max 280px wide, left 3px `--accent-primary` border, `--surface-card` bg, `--radius-md`, pad 10px 12px.
- Layout: kind badge (top, 10px uppercase muted) / title (14px semibold) / subtitle (12px muted) / optional status pill / optional 64×64 thumbnail right.
- Renders only when there's a title or thumbnail (no empty boxes). Click → `navigateToRef`.

### Share-to-channel modal
- `--surface-modal` bg, `--radius-lg`, `--z-modal`. Channel list rows (name + type badge), click to send the `^slug` chip message. `Copy link` / `Copy ref` secondary buttons. Reuses `BaseModal`.

---

## 6. Permissions & gating (UX rules)

| Action | Who | UI behavior |
|---|---|---|
| Create channel (any mode) | owner / admin | `+` in sidebar hidden for others (already done) |
| Create forum **post** | any member | `+ New Post` always visible in forum header |
| Create wiki **page** | any member (edit = page ACL) | `+ New` in tree header |
| Upload gallery **work** | any member | `+ New Work` in gallery header |
| Mark forum solution | post author + mods | `✓` only on own posts / mod |
| Edit wiki page | page ACL (default members) | `Edit` button hidden if no perm |
| Share any object | everyone | `⋯` menu always present |

Backend already enforces; the UI's job is to *hide* what the user can't do rather than error after the fact.

---

## 7. Component inventory (for hy3 cards)

New Svelte components (all under `frontend/src/lib/components/`):

```
forum/
  ForumChannel.svelte        — 3-pane shell + state
  ForumCategoryPane.svelte   — left tree
  ForumPostList.svelte       — middle list
  ForumPostRow.svelte
  ForumReadingPane.svelte    — right detail + replies
  ForumReplyNode.svelte      — recursive
  ForumComposer.svelte
wiki/
  WikiChannel.svelte         — tree + content + drawer
  WikiTree.svelte
  WikiTreeNode.svelte        — recursive
  WikiContent.svelte         — toolbar + header + body
  WikiRevisionDrawer.svelte
gallery/
  GalleryChannel.svelte      — EXISTS (extend: masonry + share menu)
  GalleryGrid.svelte
  GalleryCard.svelte
  GalleryLightbox.svelte     — + feedback markers
  FeedbackMarker.svelte
shared/
  ObjectShareMenu.svelte     — the ⋯ menu (Share/Copy link/Copy ref)
  SurfaceHeader.svelte       — title + desc + primary action
  SurfaceToolbar.svelte      — search + pills + sort
```

Shared CSS: one new file `frontend/src/styles/components/surfaces.css` holding the surface shell, pane, card, pill, and lightbox classes — all token-driven. Forum/wiki/gallery components import from it rather than re-declaring.

---

## 8. Token mapping (mock → real)

| Mock value | Real token |
|---|---|
| `#0b0b0f` bg | `--surface-app` |
| `#13131a` surface | `--surface-base` |
| `#1a1a24` hover | `--surface-hover` |
| `#22222e` border | `--border-subtle` |
| `#e0e0e5` text | `--text-heading` |
| `#8a8a96` muted | `--text-muted` |
| `#7c5cff` accent | `--accent-primary` |
| accent-soft 15% | `--accent-subtle` |
| `#2a9d8f` success | `--color-success` |
| `#e76f51` danger | `--color-danger` |
| `#f0a030` WIP | `--color-warning` |
| `12px` radius | `--radius-lg` |
| `8px` radius | `--radius-md` |

Because everything keys off tokens, the surfaces automatically follow the user's theme (including the cozy/density and accent settings already in `themeManager`).

---

## 9. What I deliberately did NOT design

- **No new glyph for gallery** — `^` auto-sense covers it (locked decision).
- **No separate "embed browser"** — unfurl is one compact card, not a rich preview framework.
- **No real-time collaborative cursors in wiki** — the live indicator (`● Maya3D editing`) is presence-only; OT/CRDT editing is a later workstream.
- **No forum voting backend design** — UI shows `▲ score ▼`; the vote API is a backend card.
- **Mobile apps** — responsive web only; native is out of scope.

---

## 10. Suggested implementation order (for the follow-on board)

1. **surfaces.css + SurfaceHeader/Toolbar** (shared shell) — unblocks all three.
2. **Forum** (most self-contained; backend `forum.rs` already exists).
3. **Gallery** (extends existing `GalleryChannel.svelte`; lightbox + markers is the bulk).
4. **Wiki** (needs page tree projection + revision model — heaviest backend).
5. **ObjectShareMenu polish** (wire the ⋯ menu into all three once they render objects).

Each surface card should include: register objects to `objectRefRegistry` on load, wire `openShareModal` on the ⋯ menu, and confirm chat chips navigate in (already handled by `navigateToRef`).
