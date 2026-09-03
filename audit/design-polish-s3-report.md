# Design Polish — Screen 3: DM list + DM thread (worker report)

Extracted from audit/design-polish-s3.log on 2026-08-05. Gate: bun run check = 6 pre-existing bun:test errors, 0 new in touched files.

— matches the "nothing new in your files" gate).

## Next Move
1. Write the deliverable punch-list report (markdown table: Area | Violation (measured, with file:line) | Rule violated | Fix applied | Before/After) covering all four files' fixes, then the three closing sections: (a) screens for human eyeball — DM hub list, DM thread view, context menu on a conversation (hover/active states), notes tab config, light/high-contrast themes; (b) deliberately NOT changed — `var(--accent)` in `background:` contexts (gradient valid: DMTab.svelte:1307, DMMessageView.svelte:1199/1299), decorative rgba background layers (DMMessageView.svelte:821-824 radial/linear gradients), #rgba blue directions highlight (DMMessageView.svelte:1144-1145), sub-4px message rhythm `gap: 0.05rem`/`padding: 0.12rem 0` (DMMessageView.svelte:986/999), brand system, shared ChatComposer/ChatMessagesPane (belong to chat-surface pass); (c) critique — ship after human screenshot check.
2. Stop after the report — do not start the Chat surface or other screens.

## Relevant Files
- `/var/home/Ronin/wabi/frontend/AGENTS.md`: audit punch list, screen order, verification gate, headless-Chromium caveat.
- `/var/home/Ronin/wabi/frontend/src/styles/tokens.css`: only token source of truth (semantic + overriding legacy block).
- `/var/home/Ronin/wabi/frontend/src/lib/theme/themeManager.ts` + `src/lib/theme/buildTokens.ts`: `--accent-primary`/`--color-accent-primary` is gradient; `--accent-primary-color`/`accentHex` is solid; legacy color map.
- `/var/home/Ronin/wabi/frontend/src/styles/base.css`:68: global `*:focus-visible` ring via `--shadow-focus-ring`.
- `/var/home/Ronin/wabi/frontend/src/lib/components/DmHub.svelte` (edited, ~625 lines after adds)
- `/var/home/Ronin/wabi/frontend/src/lib/components/DMTab.svelte` (edited; last `var(--accent)` at :1307 is intentional)
- `/var/home/Ronin/wabi/frontend/src/lib/components/DMMessageView.svelte` (edited; intentional literals at :821-824, :986, :999, :1144-1145, :1199, :1299)
- `/var/home/Ronin/wabi/frontend/src/lib/components/DmConversationView.svelte` (edited, 235 lines)
- `/tmp/opencode/check.log`: saved `bun run check` output (6 errors/71 warnings, non