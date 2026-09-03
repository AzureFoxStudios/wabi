Wabi repo at /var/home/Ronin/wabi. Dark nebula theme; semantic tokens in frontend/src/styles/tokens.css. Do NOT commit. Do NOT touch src-tauri/ or lib/tauri-*.ts.

TASK: Re-token admin CSS files — replace raw hex / rgb() literals / undefined tokens / raw font-family with semantic tokens from tokens.css.

Files in scope (ONLY these three):
- frontend/src/styles/components/admin-tab.css
- frontend/src/styles/components/admin-center-stage.css
- frontend/src/styles/components/sidebar-core-part1.css (only the .server-tagline / admin-identity rules)

Context: a prior pass already converted most of admin-center-stage.css, but ~91 raw hex hits remain there plus a few in the other two files. A partial second pass may already be mid-edit — finish the job; the end state is what matters.

Rules:
1. Read tokens.css FIRST to learn token names. It has a semantic block AND a later legacy block that wins for colors — pick the token that resolves to the currently-rendered color so nothing visually changes.
2. Replace every raw hex (#xxx/#xxxxxx/#xxxxxxxx) and rgb()/rgba() literal with the matching semantic token.
3. Replace undefined tokens with defined equivalents: --accent-red -> --color-danger; --accent-blue -> --color-info; --accent-green -> --color-success; --accent-purple -> --accent-primary-color; --color-{info,success,danger,warning}-hover -> color-mix(in srgb, var(--color-X) 80%, white) or the nearest defined hover token if one exists in tokens.css; --modal-text-secondary -> --text-secondary; --modal-text-muted -> --text-muted.
4. GRADIENT RULE: --accent-primary resolves to a CSS gradient — invalid in color:, border-color:, color-mix(). Use --accent-primary-color there. Only background/background-image may use --accent-primary. For exact resolution values you may read frontend/src/lib/theme/themeManager.ts (note: src/lib/theme/themeManager.ts, NOT src/lib/themeManager.ts).
5. Fonts: any raw font-family (Space Grotesk, Space Mono, or raw stacks) -> var(--font-sans) or var(--font-mono).
6. Color/font token pass ONLY. No layout, sizing, spacing, selector, or behavior changes.

VERIFY before finishing:
- Re-grep the three files: zero raw hex, zero rgb()/rgba() literals (except inside tokens.css which you must NOT edit), zero undefined tokens, zero raw font-family.
- cd /var/home/Ronin/wabi/frontend && bun run check — no NEW errors (6 pre-existing bun:test errors elsewhere are NOT yours).

Write a short report to audit/worker-d1-admin-css-report.md with per-file old->new replacements and the check result.
