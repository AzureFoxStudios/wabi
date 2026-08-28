# Taste-pass + perf checklist (2026-08-07)

## Hierarchy (not tokens)
- [ ] No dual primaries when embedded
- [ ] Contextual New Event|Task|Entry|Project + caret + Escape
- [ ] Full-bleed `.view-board`
- [ ] Journal one empty CTA; icon day nav
- [ ] Host not wiped by concurrent peers (`newPrimaryLabel`, `view-board`)

## Perf
- [ ] Debounced localStorage ~250ms + hide flush
- [ ] persistGate batch multi-store apply
- [ ] Calendar day Maps (not 42 full scans)
- [ ] Kanban assignee Map; no fake registeredUsers sort dep
- Details: `references/local-first-performance.md`

## Ship gates
- [ ] bun check + STATIC_BUILD
- [ ] Real browser eyeball
- [ ] Explicit deploy word before Tim
