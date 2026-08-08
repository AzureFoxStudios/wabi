# Planner UX double-check (post A–F)

Date: 2026-08-07  
Scope: Honest re-audit of shipped Planner work against critique MD bar  
(not token theater). **Still not deployed.**

## Verdict

**Not immaculate after OpenCode alone.** Second pass fixed real hierarchy/control bugs. Remaining items need your eyes in a real browser + optional E3 import/export.

## Issues found & fixed this pass

| Issue | Why it failed the bar | Fix |
|-------|----------------------|-----|
| Double primaries | Planner **New** + Calendar **+ Add Event** + Board **Add Task** + Journal **+ New Entry** = competing CTAs | Hide child primaries when `embedded` |
| Generic "New" | Button didn’t say *what* it creates | Contextual **New Event / Task / Entry / Project** |
| Board padding | 16px host padding + board chrome = cramped, not hub-like | `.view-board` full-bleed, flex column height |
| Menu dots identical | No scan hierarchy in New menu | Distinct colors per type |
| Escape | Menu stayed open | `svelte:window` Escape |
| Journal empty | Essay copy, no single action | Short empty + one “Write today’s entry” |
| Diary day nav | Bare `←` `→` text | Icon chevrons + aria-labels |
| Assignees | Only bare array; console noise | Accept `{users}` + camel/snake normalize |
| Icon tools | Weak a11y | `aria-label` / `aria-pressed` on column tools |
| Header wrap | Fixed height would squash | Wrap + min-height auto |

## Still honest gaps (not fixed)

1. **Visual QA** — you in real browser (headless useless on Wabi)  
2. **Import/export** still not in Planner  
3. **Projects** density not fully re-skinned  
4. **TaskPanel** internal chrome still “business-era”  
5. **addSignal on view switch** depends on remount race — works with `{#if}` branches; watch for “New does nothing once”  
6. **Deploy** blocked while other work is in flight  

## What already met the bar (from A–F)

- Honest non-zero stats  
- Working New → child modals via `addSignal`  
- In-surface Tasks split  
- `--biz-*` shim under `.planner-surface` (needed for child CSS, not the whole story)  
- Kanban cards/empty CTA/column min-width  
- `/business` → Planner redirect  

## Commits

- `28dfb99` — A–F revival  
- (this) `fix(planner): real UX pass…`  

## Recommendation

Do **not** deploy until concurrent work settles. When ready: hard-refresh Planner → walk Calendar/Board/Journal/Projects → New split → Tasks resize → drag a card.
