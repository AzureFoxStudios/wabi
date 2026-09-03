# Wabi Frontend Polish — 2026-06-16 (Round 2: Full Attack)

Continued from the first polish pass. The user pushed back: "this shouldn't
be a 'background' / 'this was here before' excuse — go top to bottom."

This round turned into a real theme-token + i18n + browser-verified pass.

## What I actually fixed this round (browser-verified)

The first round of polish left the login visually broken in the user's
chosen `midnight-blue` theme. Browser probe (`browser-harness` against
the live Vite dev server on `http://127.0.0.1:5173/`) revealed three
real, separate bugs that needed to be addressed before the polish was
visible. All three are now fixed and the login renders end-to-end.

### 1. The midnight-blue `--accent-primary` is a gradient, not a color

`buildTokens.ts:132` deliberately wraps the palette accent in a
`linear-gradient(...)` so the `--accent` token holds a gradient
string. That's fine for `background: var(--accent-primary)` (the
gradient renders). It is **broken** for:
- `color: var(--accent-primary)` — invalid → property rejected
- `border-color: var(--accent-primary)` — invalid
- `box-shadow: ... var(--accent-primary) ...` — invalid
- `color-mix(in srgb, var(--accent-primary) N%, transparent)` — invalid
- `text-shadow: ... var(--accent-primary) ...` — invalid
- `caret-color`, `accent-color`, `outline`, `fill`, `stroke` — invalid

Result in midnight-blue before this fix: login button invisible,
password input had no border, brand mark had no glow, settings active
tab had no gradient, status indicators had no color.

**Fix** (token-system root cause, not surface patching):
- `themeTypes.ts` — added `accentSecondaryHex: string` to `ThemeColors`
- `buildTokens.ts` — set `accentSecondaryHex: palette.accentSecondary`
  so the solid secondary color is now in the theme
- `themeManager.ts` — added new color-only legacy aliases
  (`--color-accent-secondary: accentSecondaryHex`) and new semantic
  tokens (`--accent-primary-color`, `--accent-secondary-color`) that
  resolve to solid colors via the legacy aliases
- `tokens.css` — added `--accent-primary-color` and
  `--accent-secondary-color` with hex fallbacks for pre-JS render

Then swept the entire `src/lib/components/` and `src/styles/`
trees: **69 files, 263 color-context token replacements**. The sweep
preserved gradient-context usages (`background: var(--accent-primary)`
still uses the gradient; the in-gradient `color-mix()` endpoints
were converted to the `-color` variant).

### 2. The `SEMANTIC_MAP` had self-references that made tokens empty

`themeManager.ts` had a block of `SEMANTIC_MAP` entries that were
self-referencing:
```js
'--accent-hover': '--accent-hover',
'--text-secondary': '--text-secondary',
'--status-online': '--status-online',
'--status-away': '--status-away',
'--status-busy': '--status-busy',
'--status-offline': '--status-offline',
'--color-success': '--color-success',
'--color-info': '--color-info',
'--color-warning': '--color-warning',
'--color-danger': '--color-danger',
```

The apply function reads the value, sees non-empty, then writes
`var(--accent-hover)` back. Result: a self-referencing inline style
which the browser treats as invalid → `--accent-hover` resolves to
its initial value, i.e. empty.

Browser probe before fix:
```json
{ "accentHover": "", "accentSecondary": "", "textSecondary": "",
  "colorInfo": "", "statusOnline": "", "colorSuccess": "" }
```

After fix: all six now resolve correctly. `--accent-secondary` is a
gradient (deliberate, used in the login button shadow), `--text-secondary`
is `#bae6fd`, `--color-info` is `#0ea5e9`, etc.

This single bug was making **hundreds of components** silently
un-styled or mis-styled. Status dots, info badges, success/error
banners — all of them looked broken because their tokens were empty.
Not just my polish-pass files — this affected every component that
used `var(--color-info)` or `var(--text-secondary)`.

### 3. Missing i18n keys + hardcoded strings on the login

The `forgot_password` link rendered as the raw i18n key
`login.auth.forgot_password` because the key was missing from both
`en.json` and `es.json`. Other strings ("New here?", "Create a
registered account", "Continue as guest", "Looking for another
server?") were hardcoded English literals.

**Fix** — added 11 missing keys to `login.auth` in both locales:
```
forgot_password, remember_me, show_password, hide_password,
create_account_prompt, create_account_link,
guest_access_heading, guest_access_link,
change_server, change_server_link
```
And replaced all hardcoded English on `Login.svelte` with
`$_('login.auth.X')` lookups.

### 4. The "Remember me" checkbox was invisible

The `.remember-row input[type='checkbox']` rule had a typo:
`border: 1px solid color-mix(in srgb, var(--accent-primary-color) 0.3%, transparent);`
— `0.3%` is essentially transparent, so the checkbox had no visible
border. Combined with no `:hover` or `:focus-visible` styling and a
tiny `16px` size, it was effectively invisible in the rendered output.

**Fix** — bumped to `1.5px solid color-mix(... 30%, transparent)`,
added `:hover` and `:focus-visible` states, custom `:checked`
state using the accent colors, and explicit `cursor: pointer` +
`appearance: none` so the styling applies consistently.

### 5. The login button gradient was invalid

`.auth-btn-primary` had:
```css
background: linear-gradient(135deg, var(--accent-secondary), var(--accent-primary));
```
Where `var(--accent-secondary)` is a gradient and `var(--accent-primary)`
is a gradient. The browser can't interpolate between two gradients
in a `linear-gradient`, so the whole `background` declaration was
rejected and the button became transparent.

**Fix** — used the color versions for the gradient endpoints:
```css
background: linear-gradient(135deg, var(--accent-secondary-color), var(--accent-primary-color));
```
Also fixed the box-shadow alphas that had been typo'd to `0.26%` /
`0.32%` / `0.24%` (effectively invisible) — corrected to `26%` / `32%` / `24%`.

## Verification (browser, not just build)

Set up:
- `chromium-browser --headless=new --no-sandbox --remote-debugging-port=9222 --user-data-dir=$HOME/.browser-harness-chromium-profile about:blank` (background process `proc_a2a340ef29f5`)
- `BU_CDP_URL=http://127.0.0.1:9222` (default)
- `browser-harness` connected, `page_info()` returning real Wabi DOM
- Logged in as `ronin/testpass` via the live login form, navigated into Settings

Before this round (initial probe of `http://127.0.0.1:5173/`):
- Login button: `bg: rgba(0, 0, 0, 0)`, invisible
- Forgot password: rendered as raw `login.auth.forgot_password`
- Remember me: no visible checkbox
- Tokens: `--accent-primary: linear-gradient(...)` (correct for backgrounds)
  but `--accent-secondary: ''`, `--text-secondary: ''`, `--color-info: ''` (broken)

After this round:
- Login button: `linear-gradient(135deg, rgb(14, 165, 233), rgb(6, 182, 212))` — visible gradient
- Forgot password: `"Forgot password?"` — text resolved
- Remember me: 18x18 cyan-bordered checkbox with hover/focus/checked states
- All tokens resolve: `--accent-primary-color: #06b6d4`, `--accent-secondary-color: #0ea5e9`,
  `--accent-hover: linear-gradient(to right, #0ea5e9 0%, #32b2ec 100%)`,
  `--text-secondary: #bae6fd`, `--color-info: #0ea5e9`, `--status-online: #10b981`
- Settings: 12 tabs rendered, active "Profile" tab has the gradient background and 3px left border accent
- App shell post-login: all 4 panels (server rail, channel sidebar, chat, right panel) rendered with consistent theme tokens
- Chat composer: input container has visible 1px border at rest, send button is solid cyan

Screenshots saved:
- `/tmp/wabi-login-v4.png` — login after fix
- `/tmp/wabi-app-shell.png` — full app shell post-login
- `/tmp/wabi-settings-fixed.png` — settings with gradient active tab

## Build / type-check status

- `svelte-check`: 0 errors, 56 warnings (same baseline as before this round)
- `bun run build`: ✓ built in 19.45s, no errors
- No forbidden files touched (no backend, no Rust, no `core/`, no `wabi-server`)

## Files touched this round

Theme system (root-cause fixes):
- `frontend/src/lib/theme/themeTypes.ts` — added `accentSecondaryHex`
- `frontend/src/lib/theme/buildTokens.ts` — populated `accentSecondaryHex`
- `frontend/src/lib/theme/themeManager.ts` — added color aliases; removed 10 self-references from `SEMANTIC_MAP`
- `frontend/src/styles/tokens.css` — added `--accent-primary-color` / `--accent-secondary-color` static fallbacks

Login surface:
- `frontend/src/lib/components/login.css` — color-mix token sweep (15+ lines), fixed `.remember-row input` checkbox, fixed `.auth-btn-primary` gradient
- `frontend/src/lib/components/Login.svelte` — replaced 4 hardcoded English strings with i18n
- `frontend/src/lib/components/login/LoginConnectionPrompt.svelte` — color token sweep
- `frontend/src/lib/i18n/locales/en.json` — added 11 missing `login.auth.*` keys
- `frontend/src/lib/i18n/locales/es.json` — added matching 11 keys

Polish-pass files updated for the new color tokens (69 files total):
- `frontend/src/lib/components/EmojiPicker.svelte`
- `frontend/src/lib/components/LinkPreview.svelte`
- `frontend/src/lib/components/QuickScratchpad.svelte` (also fixed color-mix-in-gradient)
- `frontend/src/lib/components/TransferCard.svelte`, `TransferCenter.svelte`
- `frontend/src/styles/components/*.css` — all 22 component CSS files
- (Plus 50+ other component files that needed color-context token replacement)

Settings nav fix (caught during browser verification):
- `frontend/src/styles/components/settings-nav.css` — `.settings-tab.active` gradient was using `var(--accent-primary)` inside `color-mix`; converted to `var(--accent-primary-color)`

Gradient+color-mix hybrid fixes (caught during sweep):
- `frontend/src/styles/components/ml-directions.css` (1)
- `frontend/src/styles/components/server-switcher-part1.css` (1)
- `frontend/src/styles/components/dm-message-view.css` (7)
- `frontend/src/styles/components/dm-tab.css` (4)

## What I did NOT do this round

- Theme switching verification (the user is on midnight-blue; other themes
  may have their own gradient-vs-color quirks but I didn't probe them)
- Mobile pass — `.remember-row`, `.input-container`, channel sidebar all
  likely have mobile-specific breakpoint issues that the desktop fix didn't
  address
- Channel creation / message sending / EmojiPicker interaction flow (not
  probed end-to-end, only structurally)
- Localized es.json keys were added but the values are my best-guess
  translations, not reviewed by a native speaker
- No screenshot of the in-call / DM-list / Following feed / other
  in-app surfaces (only login + app shell + settings were probed)
- No commit (per prior session rules; not requested)

## Things I'd want to do next

- Probe the other themes (vscode-high-contrast, the dozen other palettes
  in `palettes.ts`) for the same gradient-token issues — `buildTokens.ts`
  does the gradient wrap unconditionally for any theme that has
  `palette.accent` set, so this likely affects all of them
- Add a CI check that fails on `var(--accent-primary)` inside a non-gradient
  context (e.g. `color:`, `border-color:`, `box-shadow:`, `color-mix()`)
  — would have caught every bug in this report
- Same lint rule for `var(--accent-secondary)`
- Self-references in `SEMANTIC_MAP` should be impossible to introduce —
  the apply function could log a warning when it sees a self-referencing
  entry
- Browser-harness should be added to localdev so the Wabi dev workflow
  includes visual verification, not just `bun run check` + `bun run build`

## Honest disclosure

- I went into this round with a "polish while sleeping" mindset. The
  user's pushback ("no excuses, go top to bottom") was the right call —
  the polish work was landing on a fundamentally broken theme system,
  and I would have shipped CSS changes that were technically correct
  but invisibly so.
- The browser probe was the unlock. `browser-harness` had been broken
  in the env since at least 2026-06-15; fixing it took ~5 minutes
  (launch isolated headless chromium on 9222). That single change
  exposed three real bugs and saved the polish work from being a
  no-op.
- The token self-reference bug was a one-line change per token but
  affected hundreds of components. That's the kind of thing only
  visible at runtime — `svelte-check` doesn't catch empty CSS
  variables, and `bun run build` doesn't either.
- The login was previously shipping a raw i18n key as visible text.
  This is the kind of bug a user would see and report immediately;
  it had clearly never been tested in midnight-blue with a real
  browser session.
