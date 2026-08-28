# CSS duplicate-selector cascade — "verified deploy, unchanged UI" (2026-08-08)

## Symptom sequence

1. Multiple deploys shipped (binary SHA match, container StartedAt fresh, public CSS hash == embedded hash, `/health` 200).
2. User hard-refreshes (Ctrl+Shift+R), unregisters the service worker — site STILL looks the same / features look "mixed and matched" from different build generations.
3. User reasonably concludes the work was never done.

## Triage order (each step cheap, in order)

1. `sha256sum` local binary vs Tim binary; `docker inspect wabi-server --format '{{.State.StartedAt}}'` must be AFTER binary mtime (in-place `mv` + `compose up -d` can keep serving the old inode — force `docker rm -f` + `up -d`).
2. `curl https://wabi.chat/ | grep -oE '0\.[A-Za-z0-9_-]+\.css'` vs `strings target/release/wabi-server | grep -oE '0\.[A-Za-z0-9_-]+\.css'` — CF edge staleness if different.
3. Check the SW: `curl https://wabi.chat/sw.js` and confirm `__WABI_SW_VERSION__` in `frontend/vite.config.ts` is **committed** (an uncommitted bump ships nothing; the precached shell never invalidates).
4. If all of the above are clean and the user still sees stale/broken UI on a fresh browser profile: **stop blaming cache. Grep the broken component's CSS classes across the whole `frontend/src` tree.**

## The actual root cause (kanban "falling through the floor")

`.kanban-board` was defined twice with conflicting layout:

- `frontend/src/styles/components/kanban-board-part1.css` (~line 360): `display: flex; flex-direction: row; flex-wrap: nowrap; width: max-content` — correct horizontal spread.
- `frontend/src/styles/components/todo-list.css` (~line 160, legacy standalone-TodoTab sheet): `display: grid; gap: 1rem` — **grid with no `grid-template-columns` = single implicit column = every kanban column stacks vertically.**

`styles.css` import order: `kanban-board.css` (line ~60) BEFORE `todo-list.css` (line ~77). Equal specificity → later import wins → grid stomps flex on EVERY load. Deterministic, not a cache ghost. The board only ever looked right when unrelated wrapper rules compensated.

Same file also duplicated `.kanban-column`, `.kanban-card`, `.filters`, `.add-btn` etc. — planner-era components (`KanbanBoardImpl.svelte` has NO local `<style>`) inherited whichever sheet won.

## Fix pattern

- Delete the legacy duplicate blocks from the older sheet (grep first that the classes aren't used by the legacy component the sheet actually owns).
- Do NOT fix by reordering imports — that leaves two sources of truth and re-breaks on the next edit.
- Detection recipe: `grep -rn '^\.<broken-class>' frontend/src/styles/` — more than one definition of the same top-level class = cascade war candidate.

## Companion failure: planner button duplication

Same session: `KanbanBoardImpl.svelte` had its own embedded `kanban-add-btn` duplicating PlannerWorkspace's New split-button, and a "Manage columns" button using a `+` SVG (reads as a redundant Add). UI-audit rule: when a workspace host owns the primary action, embedded children must not render their own primaries.
