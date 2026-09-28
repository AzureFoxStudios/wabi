# Planner redesign acceptance — 2026-09-28

Worktree candidate; not a Tim deployment. Actual Wabi frontend at local port 47332 proxies its disposable Authority at 47311. The separate HTML demonstration is not used for this acceptance.

## Implemented

- Projects inventory with search; full-width selected-project Overview; optional tree and Reports & sprints. Saved Insights navigation redirects to Projects.
- Overview rolls up unique non-archived/non-scrapped tasks across descendants. Direct chart scopes remain unchanged.
- Journal stream without an empty rail, entry editor, sanitized Markdown, tables and code, preview, inert code/text file imports, image attachments and clipboard-image handling. Images-only entries are saveable.
- Real related-card picker: title search, status/assignee, selection/removal, context preview without replacing the editor draft.
- Create requests no longer leak from Board into a newly mounted Projects/Journal view; browser-tested after cancelling a Board create dialog.
- “Add my name” replaces confusing Sign off language and explicitly does not publish.
- Honest worker failure reporting when earlier recorded steps succeeded.

## Verification

- Frontend check: zero errors (90 warnings in the final full workspace check).
- Static frontend build passed. A transient build-output collision occurred during an earlier attempt; subsequent builds ran with the development server stopped.
- Three helper tests passed: cycle-safe descendant scope, unique task rollups, fence-preserving code import. Five worker regression tests passed, including invalid response after a successful write.
- Real browser: saved and reopened a linked card relationship on the disposable shared board.
- Real browser: created Convention season → Forest poster collection. Added an in-progress child task with an October 2 deadline; the parent Overview showed one total task, the child deadline and the in-progress task.
- Real browser: saved a Journal entry, imported a TypeScript fixture, attached a disposable SVG poster, and verified syntax-highlighted inert code plus its image in the saved entry view, then reloaded the app and verified both remained.
- Narrow 700 px Overview checked and viewport restored. Clipboard image paste added a second image to an existing draft and Cancel restored the saved entry. Broader physical-device and generic file attachment acceptance remain open.

Screenshots are under `screenshots/2026-09-28-project-proof/`. Earlier numbered “after” shots document iterations; the latest captures should be used to review final layout.

## Remaining product work

This batch does not provide shared calendar, dated shared Journal or server-owned project/sub-project entities. Typed dependencies and inverse relationships, opt-in event rules, budget reservation, helper runs and Lore tool integration remain in the implementation plan. Personal Planner content remains on the device/account. Generic binary file attachments are not yet part of the local Journal record.
