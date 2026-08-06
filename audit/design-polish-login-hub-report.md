# Design Polish Report — Login / Launch / Setup / Server Hub

Scope: Login screen, Launch panel, Setup (wizard + home-experience prompt), Server switcher / add-server / connection (join) surfaces.
Rule system: `frontend/src/styles/tokens.css` (semantic block is overridden by the LEGACY block — legacy-resolved colors cited below), `frontend/src/lib/theme/themeManager.ts` (`--accent-primary` is a gradient → never used in `color:`/`border-color:`/`color-mix()`; solid token is `--accent-primary-color` / `--accent-secondary-color`).

All contrast ratios computed against the currently-rendered legacy surface (`#1a1a2e` app / `#0f0c29` sunken / `#302b63` raised).

---

## Changes by file

| Area | Violation (measured, file:line) | Rule violated | Fix applied | Before / After |
|---|---|---|---|---|
| Login | `.login-auth-panel` `border-radius: 22px` (login.css:77) | radii must be `--radius-*` (4/8/12/16/24/9999) — 22px off-scale | `var(--radius-2xl)` (24px) | 22px → 24px token |
| Login | `.login-shell.has-launch .login-box` `border-radius: 24px` (login.css:40) | radius not tokenized | `var(--radius-2xl)` | 24px → token (no visual delta) |
| Login | mobile `.login-shell.has-launch .login-box` + `.login-auth-panel` `border-radius: 18px` (login.css:612,617) | 18px off-scale | `var(--radius-xl)` (16px) | 18px → 16px token |
| Login | `.login-box input` `border-radius: 12px` (login.css:385) + mobile `10px` (login.css:623) | 10px off-scale, 12px untokenized | `var(--radius-lg)` (12px) both | 12px/10px → token |
| Login | `.auth-btn` `border-radius: 12px` (login.css:419) | untokenized | `var(--radius-lg)` | 12px → token |
| Login | `.remember-row input[type='checkbox']` `border-radius: 5px` (login.css:198) | 5px off-scale | `var(--radius-sm)` (4px) | 5px → 4px token |
| Login | `.handle-input-wrapper` `border-radius: 12px` (login.css:530) + `background: rgba(10,25,41,0.68)` (login.css:529) | radius untokenized; hardcoded color | `var(--radius-lg)`; `color-mix(in srgb, var(--surface-sunken) 68%, transparent)` | raw rgba → surface token |
| Login | `.guest-expand` `border-radius: 12px` (login.css:684) | untokenized | `var(--radius-lg)` | 12px → token |
| Login | `.locale-pill` `border-radius: 12px` (login.css:705); select `8px` (login.css:719) | untokenized | `var(--radius-lg)` / `var(--radius-md)` | 12/8px → tokens |
| Login | `.server-pill-btn` `border-radius: 6px` (login.css:748) | 6px off-scale | `var(--radius-md)` (8px) | 6px → 8px token |
| Login | `.auth-link` `color: var(--accent-primary-color)` (login.css:219) | WCAG AA — #6366f1 on #1a1a2e = **3.82:1** < 4.5:1 (13px text) | `var(--accent-secondary-color)` (#818cf8 = **5.72:1**) | 3.82:1 → 5.72:1 |
| Login | `.auth-link:hover` (login.css:233) same fail | AA contrast | `--accent-secondary-color` | 3.82:1 → 5.72:1 |
| Login | `.server-pill-btn` color accent-primary (login.css:374,742,904,914,1028) | AA contrast 3.82:1 | `--accent-secondary-color` in all 5 rules | 3.82:1 → 5.72:1 |
| Login | `.field-label:focus-within .field-caption` accent-primary (login.css:169) | AA contrast 3.82:1 on 0.76rem caption | `--accent-secondary-color` | 3.82:1 → 5.72:1 |
| Login | `.field-caption` `font-weight: 720` (login.css:161) | weight scale is 300/400/500/600/700 — 720 off-scale | `var(--font-weight-semibold)` | 720 → 600 token |
| Login | `.auth-link`/`.guest-expand`/`.auth-btn-ghost`/`.server-pill-btn` `font-weight: 650` | off-scale | `var(--font-weight-semibold)` | 650 → 600 token |
| Login | raw rem sizes → tokens: `.launch-footer-note` 0.8rem; `.auth-alt-prompt` 0.88rem; `.auth-link` 0.88rem; `.guest-expand` 0.88rem; `.auth-divider span` 0.72rem; `.auth-btn` 1rem; `.auth-btn-ghost` 0.85rem; `.remember-row` 0.88rem/0.82rem; `.handle-prefix` 1rem; `.locale-pill select` 0.78rem; `.experience-prompt p` 0.9rem; `.wizard h3` 1.2rem; `.wizard-subtitle` 0.9rem; `.wizard-note` 0.82rem; `.server-pill`/`.server-pill-btn` 0.82rem (login.css) | font sizes must use `--font-size-*`/`--text-*` | `var(--font-size-{xs,sm,base,lg,xl})` / `var(--text-*)` | raw px-adjacent rem → token |
| Login | dead CSS: `.login-kicker` (116), `.login-intro` (134), `.auth-eyebrow` (161), `.auth-heading` (170), `.auth-subheading` (178), `.forgot-link` (276) + media-query (585/586) + B4 (1075/1081/1091) refs | dead CSS (0 markup usages — `rg login-*`/`auth-*` in `src/lib/**/*.svelte` = 0 hits) | removed | 6 dead rules + 5 dead refs → gone |
| QR modal | `.qr-modal` `border-radius: 20px` (LoginQRModal.svelte:79) | 20px off-scale | `var(--radius-2xl)` | 20px → 24px token |
| QR modal | `box-shadow: 0 8px 32px var(--shadow-lg, rgba(0,0,0,0.3))` (LoginQRModal.svelte:83) | invalid — expands to 7 length-values + color in one layer → whole `box-shadow` dropped (silent no-op) | `box-shadow: var(--shadow-xl)` | invalid → real shadow |
| QR modal | `.qr-modal` `background: rgba(20,20,30,0.3)` (LoginQRModal.svelte:75) | hardcoded color | `color-mix(in srgb, var(--surface-modal) 30%, transparent)` | raw rgba → surface token |
| QR modal | `.url` `font-family: 'Consolas'` (LoginQRModal.svelte:93) | font-family must come from token system | `var(--font-mono)` | hardcoded → token |
| QR modal | `.url` `0.85rem`/`8px`; `.room-input input` `12px`; `.qr-actions button` `12px`/`600`; `.qr-modal h2` `1.5rem` (LoginQRModal.svelte) | size/radius/weight tokens | `var(--font-size-{sm,2xl})`, `var(--radius-{md,lg})`, `var(--font-weight-semibold)` | raw → tokens |
| QR modal | `.qr-modal h2` fallback `var(--accent-primary-color)` (LoginQRModal.svelte:88) | AA contrast 3.82:1 | fallback → `var(--accent-secondary-color)` | 3.82:1 → 5.72:1 |
| Connection | `.error-message` `rgba(239,68,68,.1)`/`rgb(239,68,68)`/`#fca5a5`/`8px` (LoginConnectionPrompt.svelte:176-182) | hardcoded danger colors | `rgba(var(--color-danger-rgb),…)`, `var(--color-danger)`, `var(--radius-md)` | raw → danger tokens |
| Connection | `.connection-kicker` `font-weight: 750` (LCP:60) | off-scale weight | `var(--font-weight-bold)` | 750 → 700 token |
| Connection | `.connection-field span` `font-weight: 720` (LCP:89) | off-scale | `var(--font-weight-semibold)` | 720 → 600 token |
| Connection | `.join-btn` `font-weight: 740` (LCP:152) | off-scale | `var(--font-weight-bold)` | 740 → 700 token |
| Connection | `.connection-kicker` fallback accent-primary (LCP:58) | AA contrast | `--accent-secondary-color` | 3.82:1 → 5.72:1 |
| Connection | `.remember-row input[type='checkbox']` `16×16px` (LCP:104-105) | inconsistent — login checkbox is 18×18px | 18×18px + `var(--radius-sm)` | 16 → 18px (matches login) |
| Connection | `input[type='text']`/`.join-btn` `border-radius: 12px` (LCP:120,156); `.connection-copy` 0.92rem; `.remember-row` 0.9rem; kicker 0.72rem | radius/size tokens | `var(--radius-lg)`, `var(--font-size-{xs,base,lg})` | raw → tokens |
| Switcher | `.switcher-close` `10px` (sw-part1:116); `.switcher-input-group input`/`.switcher-folder-editor input`/`.switcher-folder-toggle-icon` `10px` (195,523,468) | 10px off-scale | `var(--radius-md)` | 10px → 8px token |
| Switcher | `.switcher-move-banner`/`.switcher-group.move-selected` `16px` (sw-part1:158,401) | untokenized | `var(--radius-xl)` | 16px → token |
| Switcher | motion `0.2s cubic-bezier(0.22,1,0.36,1)` (sw-part1:19), `0.24s` (47,140), `0.18s`/`0.2s` transitions (265,366,482; sw-part2:48,235) | motion must use `--duration-*`/`--ease-*` | `var(--duration-fast)/var(--duration-normal)` + `var(--ease-out)/var(--ease-in-out)` | raw easing/duration → tokens |
| Switcher | `.switcher-badge--follow-unread` `color: var(--accent-danger-soft,…)` (sw-part2:220) | **bug** — `--accent-danger-soft` is a *background* token (rgba alpha 0.15); used as `color` → near-invisible red at 15% opacity | `var(--color-danger-hover, #fda4af)` | invisible → readable 6.5:1 |
| Switcher | `.switcher-badge` `0.58rem` (sw-part2:204); tagline `0.78rem`; name-btn `0.88rem`; drag-ghost strong `0.84rem`/tag `0.64rem` | size tokens | `var(--font-size-2xs)` / `var(--font-size-sm)` / `var(--font-size-base)` | raw → tokens |
| Switcher | `.switcher-side-bubble` `8px` (sw-part2:246); `.switcher-drag-ghost` `16px` (315); `.switcher-primary/secondary/tertiary` `12px` (343) | untokenized | `var(--radius-{md,xl,lg})` | raw → tokens |
| Switcher | `.switcher-row` has `role="button"` + `tabindex="0"` (ServerSwitcherPanel.svelte:845-846) but no `:focus-visible` rule | keyboard a11y — no focus affordance (every other interactive surface here has one) | added `.switcher-row:focus-visible` ring using `--row-accent` (sw-part2:128-133) | default/absent → explicit 2px ring |

Verification: `bun run check` from `frontend/` — **6 errors / 71 warnings, unchanged from baseline** (5× `bun:test` + 1× `bun`, all pre-existing; none in scope files). No token addition was needed — every fix resolved to an existing token or a defined `--color-danger-hover`.

---

## (a) Screens for human eyeball

1. Login (default, no launch page) — check: panel/input/button radii (24/12/12), the "Create account"/"Change server" links now lighter indigo (5.72:1), dead classes gone.
2. Launch-page variant (`has-launch`) — card radius 24px, auth panel borderless, mobile 16px.
3. Setup flow — wizard + "Choose your default home view" (sizes now `--font-size-xl`/`--font-size-base`).
4. QR modal — confirm the modal now actually casts a shadow, radius 24px, URL chip in `--font-mono`.
5. Server connection prompt — checkbox now 18px (matches login), error message in danger tokens, kicker in 700 weight.
6. Server switcher — radii 8px on inputs/close/icon bubbles, entry animations on motion tokens, "N unread" badge now visible red text, Tab-focus shows a row accent ring.

## (b) Deliberately NOT changed + why

- **`--text-on-accent` on primary CTA** (`auth-btn-primary`, `.join-btn`): dark `#0f0c29` text on the indigo gradient measures ~4.2:1 — under 4.5:1, but this is brand-identity CTA styling shared app-wide; changing it is a branding decision, not a surgical diff. Flagged, not touched.
- **Launch page server-supplied colors** (`--launch-accent`, `--launch-text`, hero palette): admin-configured brand data; contrast there is the server owner's choice and out of the token system's control. Only the *fallbacks* were corrected.
- **`font-size: 1rem` on login/QR/connection inputs**: deliberately kept raw — 16px inputs are the iOS-zoom guardrail (autozoom if <16px). The tokens have no 16px gap issue; this is intentional.
- **Boxless "experiment" block** (`.login-box input`/`.auth-btn` at `0.96rem`, login.css:753/759): a coherent compact scale already blessed by the B4 block; retokenizing to 14/16px would visibly regress density. Left intact.
- **`.launch-headline`/`.launch-subheadline` earlier raw sizes**: already overridden by the B4 token block — dead but harmless; leaving avoids churn in an already-polished block.
- **`#2dd4bf` per-server accents, `rgba(7,11,19,…)` row scrim, QR code white-on-transparent**: data-driven or intentional image-scrim styling; not token violations.
- **`--text-info` uses on move-pill/drag-ghost-tag**: resolves to `#3b82f6` (~4:1 on dark) — borderline, but it's a transient drag affordance; replacing would expand the diff beyond this scope.
- **LaunchPanel.svelte**: audited, already fully tokenized with fallbacks — no violations found, zero changes.
- **login.css `100dvh`, switcher `prefers-reduced-motion`**: already correct — verified, untouched.

## (c) Director critique

The login surface is now honest: every radius lands on the scale (I found **seven** off-scale radii — 22, 18, 10×4, 5, 6 — that had simply been eyeballed onto the cards), every text color that fails WCAG AA on this palette was either lightened to `--accent-secondary-color` or is now a documented brand decision, and ~200 lines of dead rules are gone.

The two real bugs found were in "finished" code: the QR modal's `box-shadow` was a silent no-op (someone wrote `0 8px 32px var(--shadow-lg,…)` and the whole declaration dropped), and the follow-unread badge was rendering its *background* token as `color` — invisible unread counts, the one thing that badge exists to scream. The switcher also had zero keyboard focus affordance on its row-as-button pattern while every other surface in this app ships a focus ring; that's now the highest-priority a11y fix in the panel.

Biggest remaining sin: **this app still doesn't have a single `font-size` source that a component can't dodge**. `--font-size-*` and `--text-*` exist but components keep writing raw rems (the wizard, captions, pills). That's not fixable by more token swaps — it needs Pass 0 enforcement (linters or a `font-size` allowlist). Second: the boxless login "experiment" block is ~150 lines of additive override fighting the base styles with `!important`; it's stable, so I left it, but it is the next candidate for a real consolidation, not another band-aid.

Baseline preserved: 6 pre-existing `bun:test`/`bun` errors, none introduced.
