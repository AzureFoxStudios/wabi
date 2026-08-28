---
name: wabi-frontend-icons
description: Replace sunburst settings SVG with proper gear icon in Wabi.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [wabi, frontend, svg, icons, css]
---

# Wabi Frontend Icons

## The Sunburst Settings Icon Problem

Wabi's code contained TWO wrong "settings gear" glyphs:

1. **Asterisk/sunburst** — `d="M12 2v4m0 16v4M4.93 4.93l2.83 2.83M18.36 18.36l2.83-2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83M18.36 5.64l2.83 2.83"` — a center dot (circle r=3) with 8 straight spokes. Literally a sun, NOT a gear. ⚠️ Do NOT trust any doc (including old versions of this skill) that calls this the "proper gear".
2. **Feather settings gear** — `d="M19.4 15a1.65..."` / `M19.4 15a1.7...` — also rejected by Ronin as "weird solar ray bs"; he wants the standard Lucide gear everywhere.

### Files that had bad gear glyphs (all fixed 2026-08-06):
- TextChannelList.svelte (2 instances — channel settings)
- UnifiedChannelList.svelte, ChannelSettingsModal.svelte, ChannelSidebar.svelte
- KanbanBoardImpl.svelte, TransferCenter.svelte, Settings.svelte
- WorkspacePanelIcon.svelte (icon 'admin'/'settings'), DmHub.svelte, AdminCenterStage.svelte (runtime icon), DMTab.svelte (group settings), UserPopoutActions.svelte
- ContextMenu.svelte (icon map `case 'settings'` — was Feather gear)
- ProfileCard.svelte (profile settings gear)

## Proper Gear Icon — Lucide "settings" (the internet standard)

The canonical gear (lucide.dev/icons/settings), stroke-based so it matches the codebase's Feather-style stroke language:

```
<circle cx="12" cy="12" r="3"/>
<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
```

Keep the existing `stroke="currentColor" stroke-width="2"` (WorkspacePanelIcon uses 1.75) — the Lucide path renders correctly at both.

## Pitfalls

1. **DMTab.svelte has `M19.07 4.93...` + polygon — it's a speaker/mute icon, NOT settings.** Never replace. Same for VoiceChannelList/CallView/CallControls/AudioSettingsTab/ProfileCard speaker glyphs. Always `grep -B5` to check context (title/class/button purpose) before replacing.
2. **AdminCenterStage 'branding' icon** uses a different sun-like ray glyph (`M12 1v2M12 21v2...`) — that one is a deliberate sun/branding icon, leave it.
3. **Multiple instances per file** — TextChannelList had the icon twice. Both need replacing.
4. **SVG compiles into JS** — full rebuild needed: `STATIC_BUILD=1 bun run build` + `cargo build --release` + redeploy. Served JS grep won't find path data (Svelte compiler inlines differently). Verify against the LOCAL build output instead: `grep -rl 'M12.22 2h-.44' frontend/build/_app/immutable/chunks/` and `grep -rl 'M19.4 15a1.65' frontend/build/_app/immutable/chunks/` (must be empty).
5. **Files get refactored/split over time** (TextChannelList → UnifiedChannelList appeared later). Grep the WHOLE frontend/src, not just the skill's file list.
6. **Later feature commits re-introduce the bug** — 2026-08-06: after the full gear sweep was committed, commit `2b5a3b1` (handoff A–F: "popout UX (mute/deafen/settings/share)") landed and re-added the sunburst gear in `UserPopoutActions.svelte` AND the Feather gear in `ContextMenu.svelte`'s icon map. When the user reports "the gear still looks wrong" after a deploy, first check whether a NEWER commit re-added it: `git merge-base --is-ancestor <fix-commit> HEAD` to confirm the fix is on main, then grep the CURRENT source (not git log). The sibling/parallel-agent sweep pattern (one agent does the sweep, another lands features on top) is exactly when this happens.
7. **`M12 2v4m0 16v4...` (circle + 8 straight spokes) is ALSO wrong** — it renders as a literal sun, not a gear. Ronin rejected it ("looks even less like a gear"). The ONLY acceptable glyph is the Lucide settings gear `M12.22 2h-.44...` (real teeth). Do not "improve" it with any other path.

## Verify

```bash
grep -rn 'M12 2v4m0 16v4\|M19.4 15a' frontend/src/ --include='*.svelte' --include='*.ts' | rg -v node_modules
# Should be empty after replacement
grep -rln '12.22 2h-.44' frontend/src/ --include='*.svelte' | wc -l
# Count should match number of replaced instances (15 after 2026-08-06 pass)
```
