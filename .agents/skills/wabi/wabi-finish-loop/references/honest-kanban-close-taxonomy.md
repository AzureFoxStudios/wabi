# Honest kanban close taxonomy (Wave 10R)

For living markdown boards (`docs/showcase-prep-kanban.md`).

## Log / checkbox language

| Language | Meaning |
|----------|---------|
| `done` | Code on disk + scoped verify (bun/cargo/rg) |
| `code done` | Source shipped; **prod may still lag** — say so in card text |
| `parked` | Investigated; no safe FE fix; needs live stack / ops / user |
| `ops` / runbook | CF dashboard, tunnel, deploy — not app-bundle thrash |

## Never

- Green from compaction / MoA narrative without `stat`/`rg`/`git status`
- Close "fixed" when only parked
- Claim Tim live JSON when curl still returns `text/html`

## Code done vs live green (R7b pattern)

When source has `/api/places` nest but Tim binary still SPA-falls through:

- Card: **code done** + **Tim still HTML until deploy**
- Log: `code done | places stub; Tim HTML until binary deploy`
- Counts: `R7b-code` not "R7b live"

## Single close ritual

1. Checkbox → `[x]` (or parked language in text)
2. One `done`/`code done`/`parked` log row
3. Scrub every other claimed/in-progress row for that card
4. Update wave Card counts line

## Sleep / entire-list / yolo

1. Re-read board open cards first
2. Drain claim→impl→verify→single close (no half-open)
3. Hot clusters still serialize
4. No commit/push/deploy without gate
5. Wake-up: shipped table, not-green-in-prod, browser verify, next go options

See also `living-kanban-multi-agent.md`.
