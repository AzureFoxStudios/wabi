# Wabi UI Polish Pass — 2026-07-13

## Summary
Surgical visual/interaction cleanup pass. Cozy message rhythm left as-is (already accepted 2026-07-09). Focused on dead composer focus chrome, token/brand drift, and plain-CSS `:global()` no-ops that silently broke intended behavior.

| Metric | Result |
|---|---|
| Backup | `~/wabi-backups/frontend-pre-polish-2026-07-13.tar.gz` |
| Plan | `UI_POLISH_PLAN_2026-07-13.md` |
| svelte-check | **0 errors**, 75 warnings (pre-existing noise) |
| build | **✓ built** (adapter-node ok) |
| Scope | CSS + small component style blocks only |

## Changes by area

### Composer (highest impact)
1. **File:** `frontend/src/styles/styles.css`  
   **Problem:** Focus ring targeted `.composer` / `.chat-composer` classes the live DOM never uses.  
   **Fix:** Target real shell `.input-wrapper .input-container` with 12px radius + soft accent focus-within ring.  
   **Why:** Keyboard/mouse focus now has a single readable affordance.

2. **File:** `frontend/src/styles/components/chat-composer.css`  
   **Problem:** Explicit “kill all outline/box-shadow on input-container” made any ring impossible. Textarea was 13px (teeny vs 15px messages).  
   **Fix:** Stop killing shell ring; only strip textarea outline. `min-height: 44px` on container. Font `var(--chat-content-size, 15px)` + `-webkit-text-fill-color`. Fixed dead `:global(html[data-clickable-send=…])` → bare `html[…]` so clickable-send setting works again.  
   **Why:** Composer matches message type scale; focus is visible; send-button policy can actually apply (default ON = show send on focus-within).

3. **File:** `frontend/src/styles/components/chat-mobile.css`  
   **Problem:** Same dead `:global` for mobile send visibility.  
   **Fix:** Bare `html[data-clickable-send='false']` selector.

### Message chrome
4. **File:** `frontend/src/styles/components/ml-replies.css`  
   **Problem:** Discord hard gray `#b9bbbe` on reply preview text; Discord fallback on accent bar.  
   **Fix:** `var(--text-muted)` / solid accent token only.

5. **File:** `frontend/src/styles/components/ml-reactions.css`  
   **Problem:** `:global()` no-op for own-message right align; reaction stack spacing heavy under cozy 2px pads.  
   **Fix:** Bare `html[…]` selector; `gap/margin-top` tightened to `0.25rem`.

6. **File:** `frontend/src/styles/components/ml-actions.css`  
   **Problem:** `:global()` no-op for action bar left-anchor when own-messages-right.  
   **Fix:** Bare selector so right-aligned own messages get correct hover-bar side.

### Markdown / tokens
7. **File:** `frontend/src/lib/prism-theme.css`  
   **Problem:** Hard Discord blurple `#5865f2` and fixed light greys on links, blockquote, h1/h2, hr, strong.  
   **Fix:** Semantic tokens (`--text-link`, `--accent-primary-color`, `--text-heading`, `--text-muted`).

8. **File:** `frontend/src/styles/components/buttons.css`  
   **Problem:** No global `focus-visible`; primary/danger used raw `white`.  
   **Fix:** `button:focus-visible` ring; `var(--text-on-accent)` / `var(--text-on-danger)`.

9. **File:** `frontend/src/styles/components/inputs.css`  
   **Problem:** Focus used gradient-prone `--accent` + fixed glow rgba (breaks on midnight-blue).  
   **Fix:** `color-mix` rings on `--accent-primary-color` + matching `:focus-visible`.

10. **File:** `frontend/src/styles/styles.css`  
    **Problem:** Confirm danger text hard `#fff`.  
    **Fix:** `var(--text-on-danger)`.

11. **File:** `frontend/src/styles/components/settings-appearance.css`  
    **Problem:** Active theme card ring used Discord fallback.  
    **Fix:** solid accent-color mix.

12. **File:** `frontend/src/styles/components/user-popout.css`  
    **Problem:** Video-call hover used Discord fallback chain.  
    **Fix:** `--accent-primary-color`.

13. **File:** `frontend/src/styles/components/chat-core.css`  
    **Problem:** Whiteboard shell sizing used invalid plain-CSS `:global()`.  
    **Fix:** `.whiteboard-surface .whiteboard-shell`.

### Login / Lore
14. **File:** `frontend/src/lib/components/login/LoginConnectionPrompt.svelte`  
    **Problem:** Join button gradient + hover shadow hard Discord sky/blurple.  
    **Fix:** accent solid tokens + color-mix shadow; `text-on-accent`.

15. **File:** `frontend/src/lib/components/LoreChannel.svelte`  
    **Problem:** Multiple `rgba(88,101,242,…)` and `#5865f2` fallbacks.  
    **Fix:** accent-primary-color + color-mix backgrounds/rings.

## Left alone (already good or out of scope)
- Cozy density block in `styles.css` tail (user-accepted Discord groupStart).
- messages-pane `gap: 0`, markdown p kill, edit-textarea theme-safe colors.
- Right panel layout (never clamp).
- Dead-code orphan deletion (FRONTEND_AUDIT) — not visual polish.
- LineDm plugin skin (plugin surface, lower priority).
- Remaining `#5865f2` as *fallbacks only* in call-modal / todo-list (not pure literals in chat core).

## Behavior note (intentional, was previously dead)
Default `clickableSendEnabled: true` now actually hides the send button until the composer is focused (Discord-like). Previously the CSS was a no-op because of invalid `:global()` in plain CSS. If that feels wrong in practice, toggle Appearance → clickable send OFF, or we can flip the default.

## Remaining rough edges
1. Call modal / todo-list still have `#5865f2` **fallbacks** inside `var(--accent, …)` — low risk when themes set tokens, but still brand-scented.
2. LineDm.css still has Discord blurple (plugin).
3. Many main-layout/reader `:global()` remain in plain CSS modules — same class of dead selectors outside chat path.
4. Native `alert()`/`confirm()` UX (audit P2) — not CSS.
5. Browser visual probe not run this pass (no live session attached). Hard-refresh and check:
   - Composer focus ring appears on click/tab into input
   - Send button show/hide matches Appearance toggle
   - Reply preview text is muted token color not Discord gray
   - Lore hover/selected states follow current theme accent
   - Cozy message pad still `2px 16px`, inter-author ~17px

## Verification checklist
- [ ] Hard refresh (Ctrl+Shift+R) with cache disabled
- [ ] Focus composer → soft accent ring + 12px radius shell
- [ ] Type multi-line → height grows; font matches message content
- [ ] Hover a message → action bar appears; keyboard focus-visible on action icons
- [ ] Continuation stack still soft (no avatar/username on continuations)
- [ ] Reply preview bar uses theme muted text
- [ ] Login join button hover glow matches theme (not Discord purple)
- [ ] Switch theme (esp. midnight-blue) → focus rings still solid colors (not broken gradients)
- [ ] Mobile width: composer icon buttons still ≥44px; send visible per settings

## Honest disclosure
- Build + typecheck verified; **not** browser-harness verified this session.
- Cozy message list was already production-tight from 2026-07-09; this pass fixed surrounding polish debt.
- Did not commit. Review + stage manually.
