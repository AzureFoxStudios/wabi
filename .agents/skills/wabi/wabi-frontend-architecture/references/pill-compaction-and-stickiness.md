# Pill compaction & stickiness — layout-stability + persistence lessons (2026-08-21)

Session-validated fixes in commits `724a09f` + `7d04cd3` on `wip/combined-handoff-2026-08-18`. Companion to `visual-junk-hunts.md` (Cases 1–3); this file covers Cases 4–5 in depth plus the general rules.

## Case 4 — view pills slide across header between channels

**Symptom:** Ronin: "some channel views move the pills to the left instead of right and jump immediately incase someone is caught off guard."

**Root cause:** desktop hover-compaction CSS for `.workspace-view-actions.compactable` (`frontend/src/styles/components/chat-header.css`) collapsed non-active `.view-open-btn`s to `width: 0`. Since the only VISIBLE pill is whichever view is active, the cluster's x-position depended on the active pill's DOM index:

- Messages active (first pill) → visible pill at far LEFT of the group
- Map/Model active (last pills) → visible pill at far RIGHT

Switching channels changed which pill was active → whole bar visibly slid. The user experiences this as random jumping ("incase someone is caught off guard").

**Fix rule (general):** compact-until-hover patterns must RESERVE item slots — animate `opacity` / `pointer-events` only. Never animate width/padding/border/margin to 0 when anything else in the row derives its position from those items. If hiding elements changes neighbors' positions, hide WITHOUT reclaiming space.

Also removed an `!important` transform conflict (`!important` on hover-scale fighting the base transform) in the same block — prefer specificity over `!important`.

## Case 5 — "sticky folders" = TWO independent dimensions

Ronin: folders "still don't seem to be sticky? (seems like it's remembering the order slightly?)". Both halves were correct — folder stickiness has two layers that fail independently:

1. **Order inside folders** persists SERVER-side (channel `position`/`parentId` projections; see wabi-sidebar-nav init-bug section). This kept working → "remembering the order slightly."
2. **Collapsed/expanded state** was a bare in-memory `Set<string>` (`collapsedCategories`, ChannelSidebar.svelte) — wiped on every reload/surface switch.

**Fix pattern:** persist collapsed ids per-server under ONE localStorage key keyed by server URL:

```
wabi-sidebar-folders = { [serverUrl]: string[] }   // collapsed category ids
```

Load at component init inside try/catch; save inside `toggleCategory()` on every toggle. Keying by server URL keeps multi-server setups independent — never persist unkeyed or server switches bleed states.

**Diagnostic lesson:** when a user reports something "isn't sticky," first ask WHICH dimension — order vs open/closed vs selection vs scroll position. Each may live in a different store (server projection / localStorage / memory-only). One dimension persisting while another silently resets produces exactly this confusing half-working report, and the fix location differs completely per dimension.

## Verification pattern used (no browser)

1. Compile each touched component with the project's own Svelte compiler (`compile()`, not just `parse()`).
2. Project-wide `npx svelte-check --tsconfig ./tsconfig.json`; triage errors — peer-file errors are not yours (confirm via `git log -1 -- <file>` + `git status --short -- <file>`).
