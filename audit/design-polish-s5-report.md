# Design Polish — Screen 5: Command palette / modals

Gate: `cd frontend && bun run check` → **6 pre-existing `bun:test` errors, 71 warnings, 0 delta in touched files** (37 files, unchanged from baseline).
Screenshot note: headless Chromium crashes on Wabi (AGENTS.md) — measured from source + token resolution against the Nebula (dark) palette; eyeball list in §a.

New tokens added to `tokens.css` (fallbacks documented inline): `--shadow-top`, `--shadow-drawer-left`, `--shadow-drawer-right`, `--popover-max-height`.

## Punch list

| Area | Violation (measured, file:line) | Rule violated | Fix applied | Before/After |
|---|---|---|---|---|
| CommandPalette z | `z-index: 100` `CommandPalette.svelte:90` | z only from `--z-*` (audit #9) | `var(--z-popover, 500)` — matches the sibling `.mention-suggestions` popover in the same composer surface | 100 → 500 (token) |
| CommandPalette radius | `border-radius: 8px 8px 0 0` `:87` | radii only from `--radius-*` | `var(--radius-md, 8px) … 0 0` | 8px → token (8px) |
| CommandPalette font drift | `.command-name` 0.95rem `:120`, `.aliases`/`.usage` 0.8rem `:129/:139`, `.desc` 0.85rem `:134` | `--font-size-*`/`--text-*` scale only (audit #12) | name→`--text-base`, desc/aliases→`--text-sm`, usage→`--text-xs` | 15.2/13.6/12.8px → 14/13/11px |
| CommandPalette font stack | `font-family: 'Monaco','Menlo',monospace` `:141` | hardcoded stack bypasses `--font-mono` | `var(--font-mono, …)` | raw stack → token stack (Monaco still present) |
| CommandPalette shadow | `box-shadow: 0 -4px 12px var(--color-glass-black-25)` `:91` | literal px shadow | `var(--shadow-top)` (new token, same value) | identical |
| CommandPalette cap | `max-height: 300px` `:88` | literal px, no token | `var(--popover-max-height, 300px)` (new token) | identical |
| CommandPalette spacing/motion | `gap: 4px` `:97`, `padding: 12px 16px` `:99`, `gap: 8px` `:127`, `transition: background 0.15s` `:106` | `--space-*` / `--duration-*` | `--space-1/2/3/4`, `var(--duration-fast, 150ms)` | identical |
| CommandPalette colors | nested broken fallbacks: `var(--surface-base, var(--surface-raised, #2a2a2e))` `:84`, `var(--text-heading, var(--text-inverse, #e0e0e0))` `:103`, `var(--color-info, var(--color-info, #6366f1))` `:125` | double-var fallbacks never resolve; hardcoded fallbacks | collapsed to `var(--surface-base, #1a1a2e)` / `var(--text-heading, #e0e0ff)` / `var(--color-info, #3b82f6)` | identical (rendered values unchanged) |
| CommandPalette states | `.command-item` had hover/selected but **no `:active`**; reduced-motion not honored | states defined for every interactive element; motion | added `:active → var(--surface-active)` + `@media (prefers-reduced-motion: reduce) { transition: none }` | added |
| BaseModal neon | `box-shadow: 0 8px 32px rgba(255, 0, 255, 0.15)` `BaseModal.svelte:94` — raw magenta glow | no hardcoded rgb; brand = indigo (audit polish plan "neon border") | `var(--shadow-xl)` | magenta glow → neutral drop shadow |
| BaseModal border | `border: 1px solid rgba(179,179,255,0.2)` `:93` | no hardcoded rgb | `var(--border-default, rgba(179,179,255,0.15))` | alpha 0.2 → 0.15 (token) |
| BaseModal close | `border-radius: 6px` `:119`, `z-index: 10` `:122`, `transition: all 0.2s` `:120`, `top/right: 1rem` `:108`, `32px` `:114` | off-scale radius (6px), z literal, motion, spacing | `--radius-md`, `var(--z-dropdown, 200)`, `var(--duration-fast)`, `--space-4`, `--space-8` | tokenized, identical values |
| BaseModal close svg | `24px` `:126` | icon size literal | `var(--icon-lg, 24px)` | identical |
| BaseModal hover | `background: var(--surface-hover, rgba(255, 0, 255, 0.2))` `:133` — magenta fallback | no hardcoded rgb | `var(--surface-hover, #302b63)` | identical (fallback never ran) |
| BaseModal overlay | `background: var(--surface-overlay, rgba(15,12,41,0.85))` `:63` | fallback ≠ token fallback | `rgba(0,0,0,0.6)` (token's documented value) | identical (token always wins) |
| BaseModal viewport | `max-height: 90vh` `:89`, mobile `calc(100vw - 2rem)` `:159` | 100vh-family / spacing | `90dvh`, `calc(100vw - var(--space-8, 2rem))` | identical |
| BaseModal motion | `animation: modalEnter 0.2s ease-out` `:92`, `slideIn 0.25s` `:103` | `--duration-*`/`--ease-*` | `var(--duration-normal) var(--ease-out)` | 200ms → 250ms (both now token, consistent) |
| PinnedMessages a11y | overlay `role="button"` `PinnedMessagesModal.svelte:139` | dialog ≠ button (audit #11; BaseModal is the pattern) | plain backdrop div + `svelte-ignore` a11y guards; panel already `role="dialog"` | button → dialog semantics |
| PinnedMessages overlay bg | `background-color: color-mix(in srgb, var(--shadow-md, …) 70%, transparent)` `:242` — **box-shadow value passed as color ⇒ invalid ⇒ transparent backdrop** | color-mix color must be a color | `var(--surface-overlay, rgba(0,0,0,0.6))` | invisible → visible dimmed backdrop |
| PinnedMessages drawer shadows | `8px 0 28px color-mix(in srgb, var(--shadow-md, #000) 35%, transparent)` `:264`/`:270` — same invalid color-mix ⇒ **no shadow at all** | no hardcoded rgb; shadow token | `var(--shadow-drawer-left/right, ±8px 0 28px rgba(0,0,0,0.35))` (new tokens) | none → intended drawer shadow restored |
| PinnedMessages motion | `animation: … 0.28s ease-out` `:265/271/280` | duration/ease tokens | `var(--duration-normal) var(--ease-out)` | 280ms → 250ms (token) |
| PinnedMessages close | `border-radius: 6px` `:347`, `width/height: 28px` `:342`, `font-size: 1.5rem` `:339` | 6px off-scale; 28px off-space-scale; font | `--radius-md`, `--space-8` (32px, = BaseModal hit target), `--text-2xl` | 28→32px hit target, token radii |
| PinnedMessages font drift | h2 `1.1rem` `:321`, `.username`/`.message-text` `0.875rem` `:419/:476`, `.timestamp` `0.7rem` `:427` | font scale only | `--text-lg`/`--text-base`/`--text-xs` | 17.6→16px title; 14px body; 11px timestamp |
| PinnedMessages spacing | `padding: 1rem 1.25rem` `:309`, `0.875rem` card `:391`, `margin-bottom: 0.625rem` `:405`, `3rem 1.5rem` empty `:366` | `--space-*` | `--space-4/5`, `--space-4`, `--space-2`, `--space-12/6` | 14px card pad → 16px; 10px → 8px; tokenized |
| PinnedMessages hover lift | `transform: translateY(-1px)` `:398`/`:452` | literal px in motion | `translateY(calc(var(--space-1, 4px) * -0.25))` | identical (-1px, token-derived) |
| CreateDM a11y | close button `×` no `aria-label` `CreateDMModal.svelte:63`; overlay `role="button"` `:50`; **no Escape-to-close** | icon-only button needs label; dialog roles (audit #11) | `aria-label="Close"`, plain backdrop, `role="dialog" aria-modal` on panel, top-level `svelte:window` Escape | added |
| CreateDM fonts | close `font-size: 2rem` `:146` (oversized outlier), `.username` `0.95rem` `:242`, `.status-text` `0.8rem` `:249`, search `0.9rem` `:174`, h2 `1.25rem` `:137` | font scale; close unifies with other modals' 1.5rem | `--text-2xl` (24px), `--text-base`, `--text-sm`, `--text-base`, `--text-xl` | close × 32px→24px glyph; aligned |
| CreateDM legacy tokens | `--modal-overlay` `:109`, `--modal-bg` `:120`, `--ui-bg-light` `:129/:145/:158/:164`, `--ui-bg-lighter` `:171`, box-shadow `-4px 0 12px rgba(0,0,0,0.3)` `:124` | legacy color namespace + hardcoded rgb | `--surface-overlay`, `--surface-modal`, `--border-subtle`, `--surface-base`, `var(--shadow-drawer-right)` | same values; drawer shadow 4px/12px→8px/28px (token, matches pinned drawer) |
| CreateDM motion | `transition: all 0.2s` `:154`, `background 0.2s` `:203` | duration tokens | `var(--duration-fast, 150ms)` | tokenized |
| CreateGroup a11y | close `x` no `aria-label` `CreateGroupModal.svelte:67`; overlay `role="button"` `:59` | icon-only button label; dialog roles (audit #11) | `aria-label="Close"`, plain backdrop, `role="dialog" aria-modal` on panel, `svelte:window` Escape | added |
| CreateGroup focus | `.group-name-input:focus { border-color: var(--accent) }` `:206` — **gradient in `border-color` = invalid, so no focus cue** | `--accent-primary` is a gradient; use `--accent-primary-color` | `border-color: var(--accent-primary-color, #6366f1)` | no focus ring → visible accent border |
| CreateGroup radius | `group-name-input`/`create-btn` `border-radius: 6px` `:199/:349` | off-scale radius (6px) | `var(--radius-md, 8px)` | 6→8px |
| CreateGroup contrast | `.chip`/`.create-btn` `color: white` on `var(--accent)` gradient `:222/:346` — dark theme **2.6–4.0:1** (fail AA 4.5:1); `.chip-remove` `rgba(255,255,255,0.8)` `:231` | WCAG AA on all themes | solid `var(--accent-primary-color)` + `var(--text-on-accent)` (matches composer send-button CTA pattern) | white-on-gradient 3.2:1 → dark-on-accent 4.8–7.9:1 (dark theme AA) |
| CreateGroup fonts/spacing | `0.95rem` `:328`, `0.8rem` `:225/:252/:335`, `0.9rem` `:201/:253`, `gap 1rem` `:274`, `0.375rem` chips `:212` | font scale / spacing | `--text-base`, `--text-sm`, `--text-base`, `--space-4`, `--space-2` | tokenized; chip gap 6→8px |
| CreateGroup legacy | `--modal-overlay` `:138`, `--modal-bg` `:149`, `--ui-bg-*` `:158/:171/:186/:204/:243`, `--accent` gradient bg `:346`, opacity `0.4/0.85/0.15` | legacy namespace / opacity tokens | `--surface-*`, `--accent-primary-color`, `var(--opacity-40/90)`, `var(--duration-fast)` | tokenized |
| Call modals a11y | overlay `<div class="call-modal-overlay">` no role `IncomingCallModal.svelte:17`, `OutgoingCallModal.svelte:15` | dialog role missing (audit #11) | `role="dialog" aria-modal="true" tabindex="-1"` | added (aria-only, no visual change) |

## (a) Eyeball screens — real browser / Tauri window

1. **Command palette** (type `/` in composer): item density, `--color-info` blue command names vs accent, selected-item bg, top radius on the upward panel, focus ring while tabbing.
2. **Any BaseModal** (e.g. channel settings): the new `--shadow-xl` drop (magenta glow removed), `--border-default` border, close-button radius/hover, 250ms entrance.
3. **Pinned messages drawer**: the backdrop now visibly dims (was transparent) and the drawer casts its left/right shadow again; title 16px, close target 32px, card hover lift.
4. **Create DM / Create Group drawers**: × glyph now 24px (was 32px outlier), focus shows an accent border on the group-name input, drawer shadow strengthened, chip + Create-Group button now dark-text-on-solid-accent (dark theme).
5. **Incoming/Outgoing call overlays** — confirm `role="dialog"` did not disturb the call visual stack.
6. **Light + high-contrast themes**: verify chip/create-btn readability; this is the known `--text-on-accent` caveat below.

## (b) Deliberately NOT changed

- **Call-modals styling** (`call-modal-part1.css`, `call-view.css`): belongs to the call surface, not this screen; only the two `.svelte` overlays got their aria roles.
- **`--text-on-accent` light-theme behavior**: it resolves to near-black `#0f0c29` in *every* theme (`--bg-sunken` is never set by themeManager). On dark the accent-CTA switch is a strict AA win; on light it trades white (7.8:1) for dark (2.4:1) — a token-level flaw that hits the composer send-button and every accent CTA equally. Fixing it belongs to a token-foundation pass, not this screen.
- **`.chip-remove { padding: 0 2px }`** and **BaseModal mobile `44px` close target**: sub-4px / off-scale touch density, deliberately kept (same call the s2 pass made for 44px targets).
- **Keyframe transform offsets** (`modalEnter` `translateY(-10px)`, `scale(0.95)`) and **`backdrop-filter: blur(...)`**: motion-path/effect parameters, not design-scale values.
- **Drawer width `400px`, `width: min(400px, 90vw)`**: layout dimensions beyond the `--space-*` ceiling (64px); left as functional values.
- **`--text-primary` in CreateDM/Group hover states**: legacy runtime token that resolves fine; not introduced by me.
- **Settings/Appearance, payments, business, sidebar modals**: other screens; they inherit the BaseModal foundation fixes automatically.

## (c) Design-director critique

Would I ship it? **Yes, after the eyeball pass.** The structural finds were real, not polish-fluff: an **invisible pinned-messages backdrop** and **shadowless drawer** (both from `--shadow-md` being passed into `color-mix` as a color — two separate silent no-ops), a **magenta glow** on every BaseModal that matches nothing in the indigo system, a **broken focus cue** on the group-name input (gradient in `border-color`), and **white-on-accent CTAs at ~3:1** on the primary dark theme. Those are the crimes; the rest is token discipline.

What I'm least happy about: (1) the chip/create-btn light-theme regression — I fixed the dominant theme at the token system's expense, and I'd only call that done if the `--text-on-accent`/`--bg-sunken` token bug is scheduled; (2) CreateDM × at 2rem was an outlier I normalized to 24px — a taste call, flag it if a human prefers the big glyph; (3) I unified the DM drawers onto the 8px/28px drawer shadow, which strengthens those panels — eyeball that it isn't too heavy. The `--shadow-top`/drawer/max-height tokens are additive and fallback-safe.

**STOP — one screen done. Command palette / modals only; no other screen touched.**
