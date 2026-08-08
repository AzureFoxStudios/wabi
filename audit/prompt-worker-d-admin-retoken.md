You are working in the Wabi repo (/var/home/Ronin/wabi). Svelte 5 + plain CSS frontend. Dark nebula theme; the single source of truth is frontend/src/styles/tokens.css. Do NOT touch src-tauri/ or lib/tauri-*.ts. Do NOT commit anything.

TASK: Admin center re-token pass — eliminate remaining raw hex / undefined-token / font drift in admin surfaces so they follow the active theme (there are 8 themes switched via themeManager.ts setting --surface-*/--text-*/--accent-* on :root).

Context (already done in a prior pass — do not redo): admin-center-stage.css was converted from raw hex to tokens, a latent --accent-primary gradient bug was fixed by using --accent-primary-color for color/border-color/color-mix, and themeManager.ts self-referencing RGB aliases were removed.

Files in scope (ONLY these):
- frontend/src/styles/components/admin-tab.css
- frontend/src/styles/components/admin-center-stage.css
- frontend/src/styles/components/sidebar-core-part1.css (only the .server-tagline / admin-identity rules)
- frontend/src/lib/components/AdminWorkspace.svelte (scoped styles only)
- frontend/src/lib/components/admin/AdminHeader.svelte (scoped styles only)
- frontend/src/lib/components/admin/FrontendMetadataPanel.svelte (scoped styles only)

What to do:
1. Grep each in-scope file for raw hex colors (#[0-9a-fA-F]{3,8}), rgb()/rgba() literals, and hardcoded font-family declarations. For every hit, replace with the correct semantic token from tokens.css (read tokens.css FIRST to learn the token names; note it has BOTH a semantic block AND a later legacy block that wins — preserve the currently-resolved rendered color, i.e. pick the token that resolves to the same value).
2. Grep for usages of tokens that are UNDEFINED in tokens.css (candidates: --accent-red, --accent-blue, --accent-green, --accent-purple, --accent-color, --color-info-hover, --color-success-hover, --color-danger-hover, --color-warning-hover, --modal-text-secondary, --modal-text-muted). Replace each with a defined equivalent (e.g. --color-danger / --color-info / --color-success / --color-warning, or a color-mix(in srgb, ...) derivation from a defined token for hover variants).
3. CRITICAL gradient rule: --accent-primary resolves to a CSS gradient, which is invalid in color:, border-color:, and color-mix(). Any such usage must use --accent-primary-color instead. Only background/background-image may use --accent-primary. Verify every --accent-primary usage in scope obeys this.
4. Fonts: if any in-scope file declares font-family with Space Grotesk / Space Mono or any raw font stack, replace with var(--font-sans) or var(--font-mono).
5. Do not change layout, sizing, spacing, or behavior. This is a color/font token pass only. Do not restructure selectors.

VERIFY before finishing:
- After edits, re-grep the in-scope files: zero raw hex, zero undefined tokens, zero raw font-family (except inside tokens.css itself which you must NOT edit).
- cd /var/home/Ronin/wabi/frontend && bun run check — no NEW errors (6 pre-existing bun:test errors elsewhere are NOT yours).
- cd /var/home/Ronin/wabi/frontend && bun run build — must succeed.

Write a short report to audit/worker-d-admin-retoken-report.md with a per-file list of replacements made (old -> new) and the check/build results.
