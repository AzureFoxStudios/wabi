# Planner / business local-first performance

## Persist path (`lib/business/store.ts` + `persistGate.ts` + `snapshot.ts`)

- **Debounce** full-snapshot stringify to localStorage (~250ms). Rapid kanban drags must not hit disk every frame.
- **Flush** on `pagehide`, `visibilitychange → hidden`, and end of batch apply.
- **Batch apply:** `beginBatchPersist()` before multi-store `set`, `endBatchPersist()` after — `setPersistFlush` runs one save. Never make `applyBusinessDataSnapshot` async (load path must stay sync).
- `triggerSync` is already debounced (~1s) in `sync.ts`; keep that separate from local save debounce.

## Calendar (`CalendarImpl.svelte`)

- Do **not** call `get(calendarEvents).filter(...)` inside each day cell.
- Build `Map<dayKey, Event[]>` / `Map<dayKey, Todo[]>` once when `$calendarEvents` / `$todos` change.
- Cap multi-day event expansion (e.g. 62 days) so pathological ranges cannot hang the tab.

## Kanban (`KanbanBoardImpl` + columns)

- Group+sort columns from `$todos` + filters only — never fake-depend on `registeredUsers` just to force redraw.
- Assignee name/color via `Map<userId, user>`, not `array.find` per card.
- Accept `/api/users` as bare array or `{ users: [...] }`; normalize `user_id`/`userId`.

## Derived stores

- Prefer single-pass bucketing over N filters of the full todo list.
- Do not attach unrelated stores to deriveds (e.g. `selectedDate` on “upcoming this week” that uses `Date.now()`).

## Scale limits (honest)

- No list virtualization yet — hundreds of cards/entries OK; thousands need windowing.
- localStorage quota still a risk for huge photo-heavy journals — plan compression or server later.
