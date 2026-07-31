# Wabi Full Design Audit — 2026-07-13

Grounded in live `~/wabi/frontend` vs design references:
- Admin + right-panel notes/DMs: `Downloads/discord-clone-admin-dashboard-design(4).zip`
- Whiteboard reattempt: `Downloads/advanced-collaborative-whiteboard-development (1).zip`
- Chat density (already accepted): `Desktop/Wabi_Mockup/standalone-wabi-ui-mockup(9).zip`

This is **audit only** — no product redesign of Wabi’s self-host/chat mission. Goal: name why Notes / center DM / right-panel Admin feel broken or awkward, and map concrete upgrades from the mocks.

---

## Executive summary

| Surface | Live state | Mock intent | Verdict |
|---|---|---|---|
| **Notes (right panel)** | Single `QuickScratchpad` textarea; multi-note `NotesWorkspace` is **orphaned** | Multi-note cards, pin/delete, color, optional @target | **Broken product identity** — wrong component mounted |
| **DM center** | Hub OR full-width conversation reusing channel Chat pane | Side-panel bubble thread; Discord-like list density | **Awkward framing** — channel UI in DM clothing |
| **Admin right panel** | `AdminTab`: long stacked forms in ~300px dock | Admin is **center stage**; right panel = Online/DMs/Notes/Map | **Wrong surface + density** |
| **Admin center stage** | Pretty shell; only Overview wired; 8× “Phase 2” | Full sections (users, roles, bans, audit…) | **Hollow shell** vs working tools elsewhere |
| **Whiteboard** | Channel surface + layers/toolbar/sync | First-class “canvas” channel, studio tools, LIVE, call adjacency | **Capable but studio-grade UX incomplete** |
| **Chat cozy** | Matches accepted Discord groupStart | mock(9) | **Leave alone** unless regressions |

---

## 1. Notes — why it feels broken

### Live wiring (root cause)
```
WorkspacePanelHost.svelte
  panel.component === 'notes' → <QuickScratchpad />   // NOT NotesWorkspace
```

- `QuickScratchpad.svelte`: one localStorage blob, footer “Saved / lines / words”. No list, no pin, no multi-note, no colors, no targets.
- `NotesWorkspace.svelte` (~508 LOC): list + resizer + editor + delete + open-in-reader — **zero imports** (orphaned).
- Mock `NotesTab.tsx`: header “Admin Notes — N”, + form, color dots, pin/delete on hover, tinted cards, skeleton load.

### UX problems
1. **Label lie**: tab says “Notes”; product is a scratchpad.
2. **No structure**: long paste becomes one wall of text; no find/select/delete note.
3. **No affordances** from mock: pin, color, @user, empty/skeleton states.
4. **Duplication**: QuickResourcesPanel also hosts notes mode → same scratchpad again; mental model further muddied.
5. **Local-only**: fine for v1, but mock assumes API-backed admin notes — set expectations or add sync later.

### Upgrade direction (ranked)
| Priority | Change | Files |
|---|---|---|
| **P0** | Mount `NotesWorkspace` (or merge best of both) for right-panel `notes` | `WorkspacePanelHost.svelte` |
| **P0** | Right-panel density: single-column note cards (mock NotesTab), collapse dual-pane list|editor when width < ~280px | `NotesWorkspace.svelte` styles |
| **P1** | Yoink mock: color chip, pin, hover actions, mono micro-labels | NotesWorkspace + tokens |
| **P1** | Empty state = mock-quality “Create first note” card (exists partially in NotesWorkspace) | — |
| **P2** | Server-backed notes if admin-moderation notes are desired | API later |

**Dangerously off if we only restyle QuickScratchpad** — that fixes paint, not product.

---

## 2. DM in center — why it looks awkward

### Live model
- Center empty DM mode: `DmHub` — full-width conversation list.
- Open thread: `DmConversationView context="center"` replaces **entire** center chat surface.
- Thread body = `ChatMessagesPane` + `ChatComposer` (channel stack) under a custom DM header.
- Right panel DMs: same conversation component, list via `DmListPanel`.

### Mock model (DmsTab)
- Lives in **300px right panel** by design.
- List: 32px avatars, status dots, unread badge, time-ago, soft rounded rows.
- Thread: **bubbles** (own right / other left), compact header with back + avatar + @handle, single-line composer.
- Not a full Discord channel clone.

### Awkwardness sources
1. **Layout mismatch**: Center gets a *side-panel* conversation chrome (back, badges, stub call icons) stretched to full stage — reads as “thin app in a wide frame.”
2. **No Discord-style DM split**: Center never shows list | thread side-by-side; it’s either hub or conversation (hard context switch).
3. **Channel message chrome in DM**: Cozy groupStart + avatars designed for multi-author channels; 1:1 DM often wants bubbles or denser own-message alignment.
4. **Header noise**: Voice/video buttons are no-ops (`on:click={() => {}}`); E2EE badge may over-promise (upload path still has e2ee hard-off history).
5. **Visual debt**: hardcoded `rgba(255,255,255,0.08)`, `color: #fff` on badges, gradient-prone `var(--accent-primary)` backgrounds.
6. **Dual entry points**: DmHub (center), DmListPanel (right), QuickResources DM mode — three slightly different list UIs.

### Upgrade direction
| Priority | Change | Why |
|---|---|---|
| **P0** | Center DM = **two-column shell**: left ~280–320px `DmHub`/`DmListPanel`, right conversation (keep channel open on left channels rail as today) | Removes “lost the list” jarring swap |
| **P0** | Context-aware message presentation: center DM uses bubble or tight 1:1 style; multi-user group keeps channel style | Mock bubble for 1:1, Discord for groups |
| **P1** | Strip or wire call buttons; honest encryption UI | Dead controls = amateur |
| **P1** | Unify list row component (avatar 32–40, unread, preview, time) shared by hub + side list | Consistency |
| **P1** | Tokenize DM header (no raw white rgba) | Theme safety |
| **P2** | Optional: keep “open in side panel” as compact bubble thread (mock), center as full | Best of both |

---

## 3. Admin — right panel awkward vs mock “looks a LOT better”

### Two competing Admin UIs

| | **AdminTab** (right panel) | **AdminCenterStage** (center) |
|---|---|---|
| Entry | `WorkspacePanelHost` → `admin` | `centerPanelView === 'admin'` |
| Content | Real tools: roles, gates, emoji rules, payments, compression, runtime, branding, users | Overview dashboard + **8 placeholders** “coming in Phase 2” |
| Density | Vertical form dump, `overflow-y: auto`, 5-col stat grid in ~300px | Mock-like sidebar + topbar + card grid |
| CSS | `admin-tab.css` cramped | `admin-center-stage.css` polished (~857 LOC) |

### Mock (`AdminDashboard` + sections)
- **Admin owns center stage** (full width): left nav sections (overview, analytics, users, channels, roles, audit, reports, emojis, invites, automod, bans, webhooks, settings).
- **Right panel is NOT admin forms** — Online / DMs / Notes / Map for live server context while managing.
- Overview: 4×2 stat cards, recent activity, top contributors, skeletons, mono labels, accent orange system (`#F26522` in mock — map to Wabi tokens, don’t hardcode Discord/orange brand).
- Permission-aware nav.

### Why live feels awkward
1. **Working admin stuffed into a dock** → horizontal overflow, tiny inputs, endless scroll of sections.
2. **Pretty center stage is empty** → user opens “admin dashboard,” sees Phase 2 walls; real work still in right tab.
3. **Information architecture split**: tools don’t match mock section map (payments/compression live; bans/audit/automod mock-only).
4. **Right panel chrome** (stack drawer, split, pin) competes with admin header — double chrome.

### Upgrade direction (aggressive, matches your “no half measures” preference)
| Priority | Change |
|---|---|
| **P0** | **Admin lives in center only.** Right-panel `admin` tab becomes a deep-link: `showAdminCenterStage()` + optional section query. |
| **P0** | **Port AdminTab panels into center sections** (users, roles, gates, payments, runtime, branding, settings) — kill “Phase 2” for anything that already exists in AdminTab. |
| **P0** | Overview already good-ish — keep mock card language; ensure stats API fills all tiles. |
| **P1** | Yoink mock section order + mono micro-labels + Card/Skeleton/RingGauge patterns already under `admin/ui/`. |
| **P1** | Right panel while in admin center: force Online/DMs/Notes/Map defaults (mock), hide admin tab from dock or mark “Open dashboard”. |
| **P2** | New mock sections (audit log UI, bans, automod, webhooks, analytics) only when backend exists. |

**Do not** spend weeks polishing AdminTab in 300px — mock proves the surface is wrong.

---

## 4. Whiteboard — mock reattempt vs live

### Live
- Channel surface toggle → `WhiteboardTab` + canvas/layers/toolbar/sync.
- Voice channel can open whiteboard.
- Real multiplayer plumbing (`boardSync`, presence, remote cursors).

### Mock (`CanvasStudio` + `DiscordShell`)
- Canvas is a **channel type** (`type: "canvas"`) with LIVE badge in channel list.
- Studio tools: brush hardness/opacity/flow/spacing, eraser, eyedropper, select, pan (space), blend modes, placed images with transform, checkerboard transparency, layer stack UI.
- Adjacent **CallRoom** + **ChatPanel** in same shell for “jam while talking.”

### Gaps / ideas to yoink (design, not full rewrite)
| Priority | Idea from mock | Live impact |
|---|---|---|
| **P1** | Channel list icon + LIVE pill when board has peers | Discoverability |
| **P1** | Toolbar denser “studio” row (size + hardness + opacity) | Feels pro |
| **P1** | Checkerboard when transparent | Correct art affordance |
| **P2** | Split view: board + mini chat / call dock | Collab jam |
| **P2** | Image place + transform handles | Moodboards |

Keep live sync architecture; skin + tool UX toward mock, don’t port React CanvasStudio blindly.

---

## 5. Right panel chrome (cross-cutting)

Mock right panel:
- Fixed **300px**, simple **icon+label tabs** (Online / DMs / Notes / Map), collapse to 48px icon rail, unread badge on DMs.

Live right panel:
- Multi-stack dock, drawer to pick any workspace panel, split/merge/pin, QuickResources overlay, detach windows.
- Powerful for power users; **noisy** for default chat.

### Audit call
- **Keep** docking power, but ship a **default “simple mode”** tab strip matching mock four: Users, DMs, Notes, Map (+ overflow “More”).
- Admin should not be a peer of Notes in the default strip once center-stage admin lands.
- Collapse rail (icons only) is worth yoinking from mock for narrow layouts.

---

## 6. Ranked program (if you “upgrade this”)

### Phase A — Stop the bleeding (1 focused pass)
1. Notes: wire `NotesWorkspace` into right panel; responsive single-column card mode.
2. Admin: center-stage only; move real AdminTab sections into center; right admin tab → open center.
3. DM center: two-column list|thread; hide dead call buttons until wired.

### Phase B — Visual parity with mocks
4. Notes cards (pin/color) from NotesTab mock.
5. DM list row + 1:1 bubble optional density.
6. Admin overview + section chrome polish (tokens, not mock orange hardcode).
7. Right panel default tab strip simplification.

### Phase C — Whiteboard studio + deeper admin
8. LIVE badge, tool densification, checkerboard.
9. New admin sections only with real APIs.

---

## 7. Files that matter (implementation map)

| Concern | Live | Mock reference |
|---|---|---|
| Notes mount | `WorkspacePanelHost.svelte` | `right-panel/NotesTab.tsx` |
| Notes full UI | `NotesWorkspace.svelte` (orphaned), `QuickScratchpad.svelte` | — |
| Notes storage | `notesStore.ts` | — |
| DM center | `MainLayout.svelte`, `DmHub.svelte`, `DmConversationView.svelte` | `DmsTab.tsx` |
| DM side list | `DmListPanel.svelte` | same |
| Admin right | `AdminTab.svelte`, `admin-tab.css`, `admin/*` panels | — |
| Admin center | `AdminCenterStage.svelte`, `admin-center-stage.css`, `admin/OverviewSection.svelte` | `AdminDashboard.tsx`, `OverviewSection.tsx` |
| Right shell | `RightPanel.svelte`, `RightPanel.css` | `dashboard/RightPanel.tsx` |
| Whiteboard | `WhiteboardTab.svelte`, `WhiteboardCanvas*`, `whiteboard/*` | `CanvasStudio.tsx`, `DiscordShell.tsx` |

---

## 8. What not to do
- Don’t redesign cozy chat density (already accepted).
- Don’t leave AdminTab as the “real” admin while center stays placeholders.
- Don’t port React/Tailwind mock code; yoink **layout, density, hierarchy, interaction**.
- Don’t hardcode mock orange `#F26522` or Discord blurple into production — map to semantic tokens.
- Don’t clamp resizable right panel max-width as a “fix.”

---

## 9. Suggested verification after any upgrade pass
- Notes: create 3 notes, pin one, delete one, survive refresh (localStorage).
- DM center: open hub → select user → list stays visible (two-column); resize to mobile still works.
- Admin: every control that works in old right AdminTab reachable from center nav; zero “Phase 2” for shipped features.
- Whiteboard: open from channel, draw, see peer cursor if 2 clients.
- Themes: midnight-blue still has solid focus colors (use `--accent-*-color`).

---

## 10. Honest bottom line

The awkwardness is mostly **information architecture**, not missing border-radius:
- Notes tab isn’t Notes.
- Admin tools are in the wrong pane while the pretty pane is empty.
- Center DM is a full-bleed side-panel pattern.

Fix those three and the app will feel closer to the Desktop/Downloads mocks than another CSS-only polish pass will.

**Ready next step (your call):** Phase A implementation plan as bite-sized cards / `/opencode` dispatch, or start with Notes mount swap only as the smallest proof.

---

## 11. Visual design language (what you actually asked for)

This section is about **eye path, placement, hierarchy, rhythm, and “why the admin mock looks pretty”** — not only wiring.

### 11.1 Why the admin mock feels pretty (design recipe)

The mock is not pretty because it has more features. It is pretty because of a **stable three-column stage** and a **tight visual system**:

```
[ 200px rail LEFT ]  [ fluid stage CENTER, max ~1200px content ]  [ 300px context RIGHT ]
         ↑                          ↑                                      ↑
   nav / identity            decision surface                    ambient / people / notes
```

**Left rail (why left, not right)**
- Western reading starts top-left. Nav belongs on the **leading edge** so the eye lands on “where am I?” before “what do I do?”
- 200px is narrow enough to stay peripheral; icons + short labels, not forms.
- Grouped with micro section headers (`Dashboard` / `Management` / `Moderation`) — eye can **scan vertically in chunks**, not one endless list.
- Active state uses a soft accent wash + brighter icon (opacity 0.6 → 1) — selection without loud full-width bars.

**Center stage (why it breathes)**
- Top bar is a **thin horizon line** (48px): title left, status/clock right. No competing buttons.
- Content has **generous padding (p-6)** and a **max-width (~1200px) centered** so cards don’t stretch into newspaper-width lines.
- Overview uses **F-pattern**:
  1. Top band = 4×2 metric cards (big numbers, tiny mono labels)
  2. Second band = two equal columns (activity | people)
- Cards: `rounded-2xl`, hairline border, optional lift on hover (`-translate-y-0.5` + deep shadow), stagger reveal. Surfaces read as **objects on a dark field**, not stacked boxes.
- Type system: **Space Grotesk** for human text, **Space Mono** for labels/counts/clock — contrast makes hierarchy without size chaos.
- Color: near-black surfaces (`#111 / #1a / #222`), borders almost invisible until hover (`#222 → #333`), **one accent** (mock orange) used sparingly for active nav and primary actions. Alerts get red/yellow; success gets green dots — never rainbow chrome.

**Right panel (why right, and why not admin forms)**
- Right is the **trailing periphery**: glanceable, not primary work.
- Fixed 300px: wide enough for avatar rows / note cards, narrow enough that it never steals the center.
- Tab chrome is **light** (icon + optional label on xl): Online / DMs / Notes / Map — context while you admin, not a second app.
- Collapse to 48px icon rail keeps stage wide when you need focus.

**Motion**
- Card reveal + list slide-in at 30–40ms stagger = “alive” without jank.
- LIVE pulse dots on green status — one language for “system is up.”

**What live already copied well**
- AdminCenterStage shell (200px left nav, topbar, overview grid, Space Mono labels) is directionally correct.
- Card/Skeleton/RingGauge under `admin/ui/` exist.

**What kills the prettiness live**
1. Center content often **empty Phase 2** → big breathing layout with nothing to rest the eye on (void feels broken, not premium).
2. Real work is shoved into the **right dock** (wrong visual weight: dense forms on the trailing edge).
3. Right panel’s multi-stack drawer/split chrome fights the mock’s calm tab strip.
4. AdminTab forms: uniform 0.55rem sections, 5-col stat grid in a ~300px column → everything is same weight; eye has no landing pad.
5. Hardcoded mock orange in a few admin CSS spots vs Wabi theme accent — pretty in isolation, off-brand in theme switch.

---

### 11.2 Eye-flow prescriptions (spatial rules)

#### Admin
| Rule | Do | Don’t |
|---|---|---|
| Primary work | **Center**, max-width content column | Stuff tools in right dock |
| Navigation | **Left** 200px, sectioned | Tabs inside a form scroll |
| Ambient context | **Right** 300px Users/DMs/Notes | Admin settings on the right |
| First paint | Stats grid top → activity mid | Jump straight into 8 form sections |
| Hierarchy | Number (2xl) > title (sm) > mono label (9–10px caps) | Everything 0.76–0.9rem |
| Density | Cards with 12–16px gaps, 16–24px section gaps | Continuous 0.6rem stack |

#### Chat (already mostly right)
| Element | Placement | Why |
|---|---|---|
| Server rail | Far left 72px | Identity / switch, peripheral |
| Channels | Next left ~240px | Navigate before content |
| Messages | Center stage | Primary reading column |
| Members / tools | Right | Glance, not compose |
| Composer | Bottom of center | Thumb/eye return path ends at input |

Keep that. Cozy density already matches accepted mock.

#### DMs in center (current awkwardness is spatial)
**Problem:** Opening a DM **replaces** the whole center with a thread that was designed as a **narrow column**. Eye expects either:
- Discord: friends list left of thread inside center, or
- Mock: thread stays on the right as a slim column.

**Prescription for center DM:**
```
[ servers ][ channels ][ DM list 280–320px | thread flex ][ right tools ]
```
- List on the **left of the stage** (after channels): scanning names is a leading-edge task.
- Thread fills remaining center: reading path stays left→right into messages, down to composer.
- Do **not** full-bleed a side-panel header across the stage with empty horizontal margin.

**If 1:1 bubble style:** own bubbles align right, peer left — works only if column is medium width; on ultra-wide, cap message column ~720–800px centered inside the thread pane so lines don’t become 120-char rivers.

#### Notes (right panel)
Mock notes work because they are **card stack, top-down**:
1. Micro header + add (top)
2. Optional compose form
3. Scroll of tinted cards

**Prescription:**
- Keep notes on the **right** (peripheral capture while chatting) — correct side for “side thought.”
- **Do not** use a dual-pane list|editor inside 300px (current NotesWorkspace grid). At ≤320px width: **list OR editor**, with back control — never three columns (list + 7px splitter + editor).
- Cards: left color rail or soft fill from note color; pin icon top-left; actions appear on hover top-right (matches mock). Eye hits pin/target first, body second.

#### Whiteboard
Mock puts canvas as **center channel content** with tools as **floating/edge chrome**, not a second full page app.
- Tool rail: typically **left or top of canvas** (leading edge of the work surface).
- Layers: **right of canvas** (inspect, not create) — same as members panel logic.
- LIVE badge in **channel list** (left) so presence is seen before entering.

---

### 11.3 Surface-by-surface visual targets (mock numbers)

**Admin shell (target parity)**
- Left rail: 200px, border-right hairline
- Topbar: 48px height
- Main pad: 24px (mock p-6); content max-width 1200px
- Stat cards: 4-column desktop → 2 tablet → 1 mobile; pad ~16px; radius 16px
- Accent active nav: `color-mix(accent 10–15%, transparent)` bg, solid accent text
- Mono labels: 9–10px, uppercase, tracking ~0.15–0.2em, color disabled/muted
- Display numbers: ~24px / semibold / tabular-nums

**Right panel (target)**
- Width 300px expanded; 48px collapsed icon column
- Tab row: 13px icons, text optional below xl
- List rows: 8–10px vertical pad, 32px avatar, 12px name / 10px preview
- Unread: 16px circle badge accent

**Notes cards**
- Radius 12–16px; border tinted `color + 22` alpha; bg `color + 08` alpha
- Body 11–12px; meta 9px mono

**DM (side)**
- Bubble max-width 85%; radius 12px with tighter corner toward speaker
- Header 40–44px; back 14px icon

**DM (center upgrade)**
- List pane 280–320px, border-right hairline
- Thread header matches channel header height (~48px) for eye alignment with chat chrome
- Composer same language as channel composer (already polished)

---

### 11.4 What to yoink purely as “pretty,” mapped to Wabi tokens

| Mock effect | Tokenized live approach |
|---|---|
| Near-black `#111/#1a/#222` | `--surface-app / --surface-base / --surface-raised` (don’t force mock black on all themes) |
| Accent orange | `--accent-primary-color` (theme solid) for active/primary; never assume orange |
| Hairline borders | `--border-subtle` → hover `--border-strong` |
| Mono labels | `--font-mono` + existing size tokens |
| Card lift | `box-shadow: var(--shadow-md)` + 1px border; 150–200ms ease |
| Shine sweep on hover | optional, respect `prefers-reduced-motion` |
| Stagger enter | already partially in admin CSS — use on real sections when filled |

Pretty **within** Wabi themes > cloning the mock’s black/orange skin.

---

### 11.5 Composition sins in live (quick hit list)

1. **Admin tools on the right** — wrong mass; eye treats right as secondary, forms feel like clutter.
2. **Empty center stage** — large negative space with “Phase 2” is the opposite of premium.
3. **Notes dual-pane in a dock** — splitter + two panes below ~320px is visual noise; feels broken even when functional.
4. **Center DM full-bleed side chrome** — header actions float in a sea of unused width.
5. **Right panel power-user chrome by default** — drawer/split/pin compete with content; mock’s calm tabs look “designed,” live looks “engineered.”
6. **Same visual weight everywhere in AdminTab** — no hero metrics band; every section is a peer → fatigue.
7. **Dead controls (DM call buttons)** — decorative chrome that fails the “honest UI” test and cheapens the header.

---

### 11.6 Design-first upgrade order (pretty + correct)

1. **Fill the pretty admin shell** with real panels (center). Immediately makes the mock layout earn its keep.
2. **Quiet the right panel default** to Online / DMs / Notes / Map (mock strip); power features behind “More.”
3. **Notes as card stack** on the right (single column). Instantly looks intentional.
4. **Center DM two-column** so list stays on the leading side of the stage.
5. **Whiteboard tool/layer left-right split** + LIVE in channel list for studio feel.

That order optimizes for **what the eye sees first** after each change, not only code cleanliness.

