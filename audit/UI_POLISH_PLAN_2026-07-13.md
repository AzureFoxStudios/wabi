# Wabi Frontend Polish Plan — 2026-07-13

## Mission
Production-grade visual + interaction cleanup only. No new features, no redesign, no right-panel clamps. Tokens + density system only.

## Baseline (pre-pass)
- Backup: `~/wabi-backups/frontend-pre-polish-2026-07-13.tar.gz` (93MB)
- Cozy density already matches accepted Discord groupStart rhythm (2026-07-09): pad `2px 16px`, inter-author `1.0625rem`, pane `gap: 0`, avatar 40px, markdown p zeroed in styles tail.
- Broken token `var(--color-primary)`: 0 matches (good).
- Brand drift Discord blurple `rgba(88,101,242)` still in: LoreChannel, LineDm.css, LoginConnectionPrompt.
- Hard Discord gray `#b9bbbe` in ml-replies; hard `#5865f2` in prism-theme links.
- Composer focus ring in `styles.css` targets `.composer` / `.chat-composer` — **live DOM uses `.input-wrapper` > `.input-container`**, and chat-composer.css **kills** outline/box-shadow on those. Focus polish is dead code today.

## Allowed files
- `frontend/src/styles/**` (especially styles.css tail, ml-*, chat-*, buttons, inputs, polish, mobile, sidebar-*)
- Surgical component style blocks only when plain CSS cannot win
- Theme-safe form fixes if edit/delete text is wrong

## Forbidden
- Backend, sockets, stores logic, calling media, Tauri
- New components/pages/features
- Right panel width/max-width/flex clamps
- rm -rf .svelte-kit as CSS "fix"
- Commits / branch switches

## Priority

### P0 (do now — high impact, low risk)
1. **Composer focus** — wire ring to real classes; remove conflicting "kill all focus" without reintroducing double glow
2. **Token/brand cleanup in chat chrome** — ml-replies `#b9bbbe`, prism link `#5865f2`, confirm/danger white, buttons text-on-accent
3. **Invalid `:global()` in plain CSS** — ml-reactions, ml-actions, chat-composer send, main-layout-part1 where selectors are dead no-ops
4. **Buttons focus-visible** + primary/danger text tokens
5. **LoginConnectionPrompt** Discord shadow → accent token
6. **ml-core base vs styles tail** — leave cascade if working; only fix if computed still wrong

### P1 (same pass if time)
- LoreChannel remaining blurple backgrounds
- Reaction pill density vs cozy (margin-top 0.5rem may feel heavy under 2px pad messages)
- Message action bar hover consistency / focus-visible
- Sidebar channel row touch targets already partly done — audit min 44px on mobile only
- Empty states already in polish.css — verify ChatMessagesPane uses them

### P2 (defer)
- LineDm plugin skin (plugin surface)
- Orphan component deletion (FRONTEND_AUDIT — not visual polish)
- alert() → toast migration
- Full a11y ARIA audit

## Verification
```bash
cd ~/wabi/frontend && bun run check
cd ~/wabi/frontend && bun run build
rg -n "rgba\\(88,\\s*101,\\s*242|#5865f2|#b9bbbe" src/styles src/lib/components --glob '*.{css,svelte}' | head
# Visual: probe .input-container:focus-within box-shadow; .message pad/mt; markdown p margin
```

## What "done" means
- P0 landed, check+build clean
- Report with file list + remaining edges
- No claim of full production without browser probe if server not running
