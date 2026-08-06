# Design Polish — Screen 6: Empty states

Gate: 6 pre-existing bun:test. From audit/design-polish-s6.log.

 | grid + radii + font | `--space-3`, `--radius-lg`, `--font-size-sm` | 13.6→12px |
| Projects empty | `padding:2rem 1rem`, `font-size:0.9rem` — `projects-view-part1.css:62` | spacing/font | `--space-8 --space-4`, `--font-size-base` | same px → token |
| Calendar empties | `empty-message padding:1rem 0`; `empty-tasks 0.85rem`(13.6px) — `calendar-view-part2.css:155`, `calendar-view-part1.css:109` | spacing/font | `--space-4`, `--font-size-sm` | 13.6→13px |
| Drawer empty | `padding:0.25rem 0.35rem 0.55rem` (off-grid 5.6/8.8px), `font-size:0.8rem` — `ModeTabsDrawer.css:166` | grid + font | `--space-1 --space-2 --space-2`, `--font-size-sm` | 5.6/8.8→8px |
| Notes empty | `font-size:0.8rem`, `padding:1rem 0.5rem` — `NotesWorkspace.svelte:508` | font/spacing | `--font-size-sm`, `--space-4 --space-2` | 12.8→13px |
| Model viewport empty | `border-radius:8px`, `font-size:0.85rem` — `ModelViewportTab.svelte:192` | radii/font | `--radius-md`, `--font-size-sm` | same px → token |
| Whiteboard empty | `gap:0.75rem`, `padding:2rem`, `64px` icon→exact `--space-16`, `opacity:0.5`, title `1.1rem`(17.6px)+`700`, desc `0.85rem`+`line-height:1.5` — `WhiteboardTab.svelte:438` | all scales | `--space-3/--space-8/--space-16`, `--opacity-50`, `--font-size-lg`, `--font-weight-bold`, `--font-size-sm`, `--line-height-normal` | 17.6→16px, rest exact |
| Map empty stage | `padding:1rem`, `gap:0.75rem` — `map-workspace-part2.css:198` | spacing | `--space-4`, `--space-3` | same px → token |
| Todo empty | `padding:3rem` — `todo-list.css:396` | spacing | `--space-12` | same px → token |
| Kanban empty column | `padding:2rem 1rem`, `p 0.85rem` — `kanban-board-part1.css:512` | spacing/font | `--space-8 --space-4`, `--font-size-sm` | same px → token |
| Business empty list | `padding:16px 10px` (10px off-grid), `font-size:0.78rem` — `businessPage.css:444` | grid + font | `--space-4 --space-3`, `--font-size-sm` | 10→12px |
| Diary list empty | `padding:2rem 1rem`, `font-size:0.9rem` — `diary-view-part1.css:48` | spacing/font | `--space-8 --space-4`, `--font-size-base` | same px → token |

**Checklist PASSes (verified, no change needed):** `polish.css .empty-state*` (shared chat/album/task pattern) fully tokenized; `forum-empty`/`forum-reading-empty` (`forum.css`), `wiki-empty` (`wiki.css`), `dm-empty`/`dm-empty-state` (DMTab/DMMessageView), all already on tokens. Focus ring on `.empty-state-btn` is covered by the global `*:focus-visible` ring (`base.css:68`) — no redundant rule added. No `100vh`, no z-index, no motion or contrast regressions (the one color change, `#94a3b8`→`--text-muted`, is theme-reactive and *fixes* a light-theme contrast risk).

## (a) Screens for a human to eyeball
1. Server switcher empty (radius 18→16) — `server-switcher-part2.css`
2. Gallery empty state (padding 80→64px vertical) — `gallery-channel.css`
3. Reader empty card (h3 22.4→24px) — `reader-tab.css`
4. Chat empty state (unchanged, sanity check) + DM empty states
5. Diary/Calendar/TaskPanel/Projects empty states (font 14.4→14, 13.6→13px)

## (b) Deliberately NOT changed
- **`FollowingFeed.svelte` `.following-empty` (20px radius, off-scale)** — the radius rule is shared with `.follow-card`/`.stream-card`; fixing it drags the whole feed's card system into this pass. It's already queued for full legacy→semantic migration (AGENTS.md audit #4). Deferred.
- **Admin empty states** (`admin-tab.css .ops-empty` 0.78rem/0.8rem) — worker D's already-re-tokenized admin surface; excluded per scope.
- **`queue-pending-count` / `watch-info` in YouTubeWatchEmbed.css** — same literal class of bug but not empty states; out of screen scope.
- **No `--space-20`-type tokens added** — off-grid values snapped to nearest scale token instead of inventing tokens, per "no new hardcoded values".
- Pre-existing uncommitted work (wabi-server, `messageStore.ts`, `AmbientBackground`, `themeManager.ts`, etc.) — untouched, not mine.

## (c) Director's self-critique
Would I ship it? Yes — with three reservations. (1) Two font snaps round *up* (12→13px gallery button, 22.4→24px reader h3) — the scale has no 12px, so 13 was the honest choice, but a 1px bump on a button is exactly the kind of thing that gets noticed; keep an eye on it. (2) The 80px→64px gallery empty padding is a real 20% reduction I made without a screenshot to justify it — the token scale simply has no 80px, and I chose rule-compliance over pixel-parity. If the 64px reads too tight, the honest fix is a `--space-*` bump in `tokens.css`, not a literal. (3) I did not add focus-visible or hover to empty-state CTAs because the global ring already handles focus and there was no measurable missing-state bug — good discipline, but it means this pass is purely a token-compliance pass, not a "taste" pass. Net: every change is defensible by rule or measurement, nothing shipped that changes theme colors, and the diff is one concern per hunk. Ship.
